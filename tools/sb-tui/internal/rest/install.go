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
// Templates is the stack's constituent template names (`spec.templates`) — the
// units the install pipeline actually deploys. A stack name itself is NOT a
// deployable template (the assembler resolves templates, not stacks), so the
// install flow must expand a selected stack into these before assembling.
type Stack struct {
	Name        string
	Tier        string
	Description string
	Installed   bool
	Templates   []string
	// Lifecycle mirrors `servicebay.lifecycle` ("atomic-wipe" | "wipeable").
	// atomic-wipe stacks (the core stack) refuse the wipe endpoint — they're
	// FACTORY-RESET-only — so the install panel blocks uninstalling them.
	Lifecycle string
}

// AtomicWipe reports whether this stack can't be uninstalled via the wipe
// endpoint (core/identity stacks; teardown is gated behind FACTORY RESET).
func (s Stack) AtomicWipe() bool { return s.Lifecycle == "atomic-wipe" }

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
				Tier        string   `json:"tier"`
				Description string   `json:"description"`
				DisplayName string   `json:"displayName"`
				Templates   []string `json:"templates"`
				Lifecycle   string   `json:"lifecycle"`
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
			st.Templates = s.Manifest.Templates
			st.Lifecycle = s.Manifest.Lifecycle
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

// InstallInProgressError signals that the box already has an active install
// (the start route's 409). It carries that job's id so the panel can reattach
// to it instead of dead-ending.
type InstallInProgressError struct{ JobID string }

func (e *InstallInProgressError) Error() string {
	return "an install is already in progress on the box"
}

// StartInstall kicks off a server-side install job for an assembled manifest
// and returns the jobId to poll. A 409 (install already running) is returned as
// an *InstallInProgressError carrying the existing jobId, so the panel reattaches
// rather than starting a second job.
func (c *Client) StartInstall(ctx context.Context, manifest json.RawMessage) (string, error) {
	body := map[string]any{"source": "sb-tui", "input": manifest}
	raw, err := c.do(ctx, "POST", "/api/install/start", body)
	if err != nil {
		if ae, ok := err.(*APIError); ok && ae.Status == 409 {
			var r struct {
				JobID string `json:"jobId"`
			}
			if json.Unmarshal(ae.Body, &r) == nil && r.JobID != "" {
				return "", &InstallInProgressError{JobID: r.JobID}
			}
		}
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

// CurrentJob is the sanitized summary of the active install job (if any), from
// GET /api/install/current — id + phase + progress counts, no secrets.
type CurrentJob struct {
	ID          string
	Phase       string
	Active      bool
	CurrentItem string
	Deployed    int
	Total       int
}

// CurrentInstall returns the active install job summary, or nil when none is
// running. Lets the launcher surface + reattach to a running install without
// already knowing the jobId.
func (c *Client) CurrentInstall(ctx context.Context) (*CurrentJob, error) {
	raw, err := c.do(ctx, "GET", "/api/install/current", nil)
	if err != nil {
		return nil, err
	}
	var doc struct {
		Job *struct {
			ID       string `json:"id"`
			Phase    string `json:"phase"`
			Progress struct {
				CurrentItem   string   `json:"currentItem"`
				DeployedNames []string `json:"deployedNames"`
				TotalCount    int      `json:"totalCount"`
			} `json:"progress"`
		} `json:"job"`
		Active bool `json:"jobIsActive"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, &APIError{Message: "malformed current-install response: " + err.Error()}
	}
	if doc.Job == nil {
		return nil, nil
	}
	return &CurrentJob{
		ID:          doc.Job.ID,
		Phase:       doc.Job.Phase,
		Active:      doc.Active,
		CurrentItem: doc.Job.Progress.CurrentItem,
		Deployed:    len(doc.Job.Progress.DeployedNames),
		Total:       doc.Job.Progress.TotalCount,
	}, nil
}

// WipeStack uninstalls a feature stack (stops its services + removes its
// data) via POST /api/system/stacks/<name>/wipe. The endpoint requires the
// `WIPE-<name>` confirmation token and hard-refuses atomic-wipe/core stacks,
// so a stray call can't tear down anything load-bearing.
func (c *Client) WipeStack(ctx context.Context, name string) error {
	body := map[string]string{"confirm": "WIPE-" + name}
	_, err := c.do(ctx, "POST", "/api/system/stacks/"+url.PathEscape(name)+"/wipe", body)
	return err
}

// AbortInstall stops a running install job.
func (c *Client) AbortInstall(ctx context.Context, jobID string) error {
	_, err := c.do(ctx, "POST", "/api/install/abort", map[string]string{"jobId": jobID})
	return err
}

// SkipCredentials resolves a needs_credentials pause, continuing the install
// with the auto-generated fallback NPM credentials.
func (c *Client) SkipCredentials(ctx context.Context, jobID string) error {
	_, err := c.do(ctx, "POST", "/api/install/skip-credentials", map[string]string{"jobId": jobID})
	return err
}

// Progress is a snapshot of a running install job, polled from the public
// jobId-gated endpoint. Percent is derived from deployed/total (the box reports
// no percentage of its own — job.progress is {currentItem, deployedNames,
// totalCount}).
type Progress struct {
	Phase       string
	CurrentItem string // the item the runner is deploying right now ("" between items)
	Deployed    int    // count of items deployed so far
	Total       int    // total items in this job
	Percent     int    // deployed/total as 0–100
	Error       string
	Active      bool
	NewLogs     string
	NextOffset  int
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
			Error    string `json:"error"`
			Progress struct {
				CurrentItem   string   `json:"currentItem"`
				DeployedNames []string `json:"deployedNames"`
				TotalCount    int      `json:"totalCount"`
			} `json:"progress"`
		} `json:"job"`
		Active     bool   `json:"jobIsActive"`
		Logs       string `json:"logs"`
		LogsOffset int    `json:"logsOffset"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, &APIError{Message: "malformed progress response: " + err.Error()}
	}
	deployed, total := len(doc.Job.Progress.DeployedNames), doc.Job.Progress.TotalCount
	percent := 0
	if total > 0 {
		percent = deployed * 100 / total
	}
	return &Progress{
		Phase:       doc.Job.Phase,
		CurrentItem: doc.Job.Progress.CurrentItem,
		Deployed:    deployed,
		Total:       total,
		Percent:     percent,
		Error:       doc.Job.Error,
		Active:      doc.Active,
		NewLogs:     doc.Logs,
		NextOffset:  doc.LogsOffset,
	}, nil
}
