package rest

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestListBackups(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{"fileName": "backup-2026-05-29.tar.gz", "createdAt": "2026-05-29T10:00:00Z", "size": 2048},
		})
	}))
	defer srv.Close()

	got, err := newTestClient(srv).ListBackups(context.Background())
	if err != nil {
		t.Fatalf("ListBackups: %v", err)
	}
	if len(got) != 1 || got[0].FileName != "backup-2026-05-29.tar.gz" || got[0].Size != 2048 {
		t.Fatalf("backups = %+v", got)
	}
}

// TestCreateBackupParsesNdjsonStream covers the multi-line NDJSON contract:
// log lines are ignored, the terminal `done` carries the result.
func TestCreateBackupParsesNdjsonStream(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/x-ndjson")
		_, _ = w.Write([]byte(`{"type":"log","entry":"archiving config"}` + "\n"))
		_, _ = w.Write([]byte(`{"type":"log","entry":"compressing"}` + "\n"))
		_, _ = w.Write([]byte(`{"type":"done","backup":{"fileName":"new.tar.gz","createdAt":"now","size":99}}` + "\n"))
	}))
	defer srv.Close()

	b, err := newTestClient(srv).CreateBackup(context.Background())
	if err != nil {
		t.Fatalf("CreateBackup: %v", err)
	}
	if b.FileName != "new.tar.gz" || b.Size != 99 {
		t.Fatalf("backup = %+v", b)
	}
}

func TestCreateBackupStreamErrorSurfaces(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"type":"log","entry":"starting"}` + "\n"))
		_, _ = w.Write([]byte(`{"type":"error","message":"disk full"}` + "\n"))
	}))
	defer srv.Close()

	_, err := newTestClient(srv).CreateBackup(context.Background())
	apiErr, ok := err.(*APIError)
	if !ok || apiErr.Message != "disk full" {
		t.Fatalf("got %v, want APIError disk full", err)
	}
}

func TestRestoreBackupSendsFileName(t *testing.T) {
	var body map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/settings/backups/restore" {
			t.Errorf("path = %s", r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer srv.Close()

	if err := newTestClient(srv).RestoreBackup(context.Background(), "old.tar.gz"); err != nil {
		t.Fatalf("RestoreBackup: %v", err)
	}
	if body["fileName"] != "old.tar.gz" {
		t.Errorf("fileName = %q", body["fileName"])
	}
}
