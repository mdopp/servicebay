package rest

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestListStacksSortsCoreFirst(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/system/stacks" {
			t.Errorf("path = %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"stacks": []any{
			map[string]any{"name": "zebra", "manifest": map[string]any{"tier": "feature", "description": "Z"}},
			map[string]any{"name": "core-b", "manifest": map[string]any{"tier": "core"}},
			map[string]any{"name": "core-a", "manifest": map[string]any{"tier": "core", "templates": []string{"nginx", "auth", "adguard"}}, "health": map[string]any{"installed": true}},
		}})
	}))
	defer srv.Close()

	stacks, err := newTestClient(srv).ListStacks(context.Background())
	if err != nil {
		t.Fatalf("ListStacks: %v", err)
	}
	got := []string{stacks[0].Name, stacks[1].Name, stacks[2].Name}
	want := []string{"core-a", "core-b", "zebra"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("order = %v, want %v", got, want)
		}
	}
	if !stacks[0].Installed {
		t.Error("core-a should be marked installed")
	}
	if stacks[2].Description != "Z" {
		t.Errorf("zebra description = %q", stacks[2].Description)
	}
	// core-a's spec.templates must be parsed so the install flow can expand it.
	if got := stacks[0].Templates; len(got) != 3 || got[0] != "nginx" || got[2] != "adguard" {
		t.Errorf("core-a templates = %v, want [nginx auth adguard]", got)
	}
}

func TestAssembleManifestSendsCheckedItems(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sb_test" {
			t.Error("assemble must be authenticated")
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		_ = json.NewEncoder(w).Encode(map[string]any{"items": []any{}, "variables": []any{}})
	}))
	defer srv.Close()

	manifest, err := newTestClient(srv).AssembleManifest(context.Background(), []string{"immich", "vaultwarden"}, nil)
	if err != nil {
		t.Fatalf("AssembleManifest: %v", err)
	}
	items, _ := body["items"].([]any)
	if len(items) != 2 {
		t.Fatalf("items = %v", body["items"])
	}
	first, _ := items[0].(map[string]any)
	if first["name"] != "immich" || first["checked"] != true {
		t.Errorf("first item = %v", first)
	}
	// The manifest is passed through verbatim to StartInstall.
	if len(manifest) == 0 {
		t.Error("manifest should be non-empty raw JSON")
	}
}

func TestStartInstallReturnsJobID(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		_ = json.NewEncoder(w).Encode(map[string]any{"jobId": "job-123"})
	}))
	defer srv.Close()

	id, err := newTestClient(srv).StartInstall(context.Background(), json.RawMessage(`{"items":[],"variables":[]}`))
	if err != nil {
		t.Fatalf("StartInstall: %v", err)
	}
	if id != "job-123" {
		t.Errorf("jobId = %q", id)
	}
	if body["source"] != "sb-tui" {
		t.Errorf("source = %v", body["source"])
	}
	if _, ok := body["input"]; !ok {
		t.Error("input manifest not forwarded")
	}
}

func TestStartInstallConflictSurfaces(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]any{"error": "install already in progress"})
	}))
	defer srv.Close()

	_, err := newTestClient(srv).StartInstall(context.Background(), json.RawMessage(`{}`))
	apiErr, ok := err.(*APIError)
	if !ok || apiErr.Status != 409 {
		t.Fatalf("got %v, want 409 APIError", err)
	}
}

// TestInstallProgressIsUnauthenticated guards the deliberate design: the
// jobId-gated progress endpoint must be polled WITHOUT a bearer, or its
// AUTH_SECRET-rotation self-heal breaks.
func TestInstallProgressIsUnauthenticated(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Errorf("progress poll must NOT send Authorization, got %q", r.Header.Get("Authorization"))
		}
		if r.URL.Query().Get("jobId") != "job-1" || r.URL.Query().Get("logsSince") != "42" {
			t.Errorf("query = %s", r.URL.RawQuery)
		}
		// Mirror the real backend shape: job.progress is an OBJECT
		// {currentItem, deployedNames, totalCount}, not a number. Percent is
		// derived (3 of 5 deployed → 60%).
		_ = json.NewEncoder(w).Encode(map[string]any{
			"job": map[string]any{
				"phase": "running",
				"progress": map[string]any{
					"currentItem":   "immich",
					"deployedNames": []string{"a", "b", "c"},
					"totalCount":    5,
				},
			},
			"jobIsActive": true,
			"logs":        "deploying immich\n",
			"logsOffset":  108,
		})
	}))
	defer srv.Close()

	p, err := newTestClient(srv).InstallProgress(context.Background(), "job-1", 42)
	if err != nil {
		t.Fatalf("InstallProgress: %v", err)
	}
	if p.Phase != "running" || p.Percent != 60 || p.CurrentItem != "immich" || p.Deployed != 3 || p.Total != 5 || !p.Active || p.NextOffset != 108 {
		t.Errorf("progress = %+v", p)
	}
}
