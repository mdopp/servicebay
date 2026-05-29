package rest

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
)

// Stack is one installable stack from the box catalog (GET /api/system/stacks).
// Tier is "core" or "feature"; Description is best-effort from the manifest.
type Stack struct {
	Name        string
	Tier        string
	Description string
	Installed   bool
}

// ListStacks enumerates the installable stack catalog. Core stacks sort first,
// then alphabetically — matching the web wizard's ordering.
func (c *Client) ListStacks(ctx context.Context) ([]Stack, error) {
	raw, err := c.do(ctx, "GET", "/api/system/stacks", nil)
	if err != nil {
		return nil, err
	}
	var doc struct {
		Stacks []struct {
			Name     string `json:"name"`
			Manifest *struct {
				Tier        string `json:"tier"`
				Description string `json:"description"`
				DisplayName string `json:"displayName"`
			} `json:"manifest"`
			Health *struct {
				Installed bool `json:"installed"`
			} `json:"health"`
		} `json:"stacks"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, &APIError{Message: "malformed stacks response: " + err.Error()}
	}
	out := make([]Stack, 0, len(doc.Stacks))
	for _, s := range doc.Stacks {
		st := Stack{Name: s.Name, Tier: "feature"}
		if s.Manifest != nil {
			if s.Manifest.Tier != "" {
				st.Tier = s.Manifest.Tier
			}
			st.Description = s.Manifest.Description
			if st.Description == "" {
				st.Description = s.Manifest.DisplayName
			}
		}
		if s.Health != nil {
			st.Installed = s.Health.Installed
		}
		out = append(out, st)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if (out[i].Tier == "core") != (out[j].Tier == "core") {
			return out[i].Tier == "core"
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}

// AssembleManifest turns a stack selection into an installable manifest
// ({items, variables}) server-side. The returned raw object is fed verbatim to
// StartInstall as the job input, so the TUI never reimplements manifest
// assembly. prefilled supplies any variable values up front (may be nil).
func (c *Client) AssembleManifest(ctx context.Context, names []string, prefilled map[string]string) (json.RawMessage, error) {
	items := make([]map[string]any, len(names))
	for i, n := range names {
		items[i] = map[string]any{"name": n, "checked": true}
	}
	body := map[string]any{"items": items}
	if prefilled != nil {
		body["prefilled"] = prefilled
	}
	return c.do(ctx, "POST", "/api/install/assemble", body)
}

// StartInstall kicks off a server-side install job for an assembled manifest
// and returns the jobId to poll. A 409 (install already running) surfaces as an
// *APIError the panel reports rather than starting a second job.
func (c *Client) StartInstall(ctx context.Context, manifest json.RawMessage) (string, error) {
	body := map[string]any{"source": "sb-tui", "input": manifest}
	raw, err := c.do(ctx, "POST", "/api/install/start", body)
	if err != nil {
		return "", err
	}
	var resp struct {
		JobID string `json:"jobId"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil || resp.JobID == "" {
		return "", &APIError{Message: "install started but no jobId returned"}
	}
	return resp.JobID, nil
}

// Progress is a snapshot of a running install job, polled from the public
// jobId-gated endpoint.
type Progress struct {
	Phase      string
	Percent    int
	Error      string
	Active     bool
	NewLogs    string
	NextOffset int
}

// InstallProgress polls /api/install/progress for a job. sinceOffset is the
// byte offset returned by the previous poll, so only new log output comes back.
// It is unauthenticated by design — the jobId is the credential.
func (c *Client) InstallProgress(ctx context.Context, jobID string, sinceOffset int) (*Progress, error) {
	q := url.Values{"jobId": {jobID}, "logsSince": {fmt.Sprintf("%d", sinceOffset)}}
	raw, err := c.doPublic(ctx, "GET", "/api/install/progress?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	var doc struct {
		Job struct {
			Phase    string `json:"phase"`
			Progress int    `json:"progress"`
			Error    string `json:"error"`
		} `json:"job"`
		Active     bool   `json:"jobIsActive"`
		Logs       string `json:"logs"`
		LogsOffset int    `json:"logsOffset"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, &APIError{Message: "malformed progress response: " + err.Error()}
	}
	return &Progress{
		Phase:      doc.Job.Phase,
		Percent:    doc.Job.Progress,
		Error:      doc.Job.Error,
		Active:     doc.Active,
		NewLogs:    doc.Logs,
		NextOffset: doc.LogsOffset,
	}, nil
}
