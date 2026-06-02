package rest

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestUploadServiceBackupPostsMultipart(t *testing.T) {
	var gotService, gotFileName, gotAuth string
	var gotFileBytes []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Fatalf("parse multipart: %v", err)
		}
		gotService = r.FormValue("service")
		f, hdr, err := r.FormFile("file")
		if err != nil {
			t.Fatalf("form file: %v", err)
		}
		defer f.Close()
		gotFileName = hdr.Filename
		gotFileBytes, _ = io.ReadAll(f)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "tarName": "home-assistant.tar"})
	}))
	defer srv.Close()

	tar, err := newTestClient(srv).UploadServiceBackup(context.Background(), "home-assistant", "ha.tar", []byte("TARDATA"))
	if err != nil {
		t.Fatalf("UploadServiceBackup: %v", err)
	}
	if tar != "home-assistant.tar" {
		t.Errorf("tarName = %q", tar)
	}
	if gotAuth != "Bearer sb_test" {
		t.Errorf("missing bearer: %q", gotAuth)
	}
	if gotService != "home-assistant" || gotFileName != "ha.tar" || string(gotFileBytes) != "TARDATA" {
		t.Errorf("multipart = service:%q file:%q bytes:%q", gotService, gotFileName, gotFileBytes)
	}
}

func TestUploadServiceBackupSurfacesError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "No backup manifest for service \"nope\""})
	}))
	defer srv.Close()

	_, err := newTestClient(srv).UploadServiceBackup(context.Background(), "nope", "x.tar", []byte("data"))
	apiErr, ok := err.(*APIError)
	if !ok || apiErr.Status != 400 {
		t.Fatalf("got %v, want 400 APIError", err)
	}
}
