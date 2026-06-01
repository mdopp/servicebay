package ui

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"servicebay-tui/internal/habackup"
)

type fakeRegistrar struct {
	called                 bool
	host, username, passwd string
}

func (f *fakeRegistrar) RegisterNasSource(_ context.Context, host, username, password string) error {
	f.called, f.host, f.username, f.passwd = true, host, username, password
	return nil
}

// TestNasUploadWithRegistrar: WithRegistrar attaches a registrar that the
// upload command will call after a successful push (#1440); without it the
// field stays nil (the FTP-only pre-install path).
func TestNasUploadWithRegistrar(t *testing.T) {
	if NewNasUpload().registrar != nil {
		t.Error("registrar should be nil by default (FTP-only path)")
	}
	r := &fakeRegistrar{}
	m := NewNasUpload().WithRegistrar(r)
	if m.registrar == nil {
		t.Fatal("WithRegistrar should attach the registrar")
	}
}

// TestResolvePath: typed paths are made openable — whitespace trimmed, a stray
// leading colon dropped, and ~ expanded (the bug behind "open :~/…: no such file").
func TestResolvePath(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no home dir")
	}
	cases := map[string]string{
		"  ~/x.tar ":  filepath.Join(home, "x.tar"),
		":~/x.tar":    filepath.Join(home, "x.tar"),
		"/abs/x.tar":  "/abs/x.tar",
		":/abs/x.tar": "/abs/x.tar",
	}
	for in, want := range cases {
		if got := resolvePath(in); got != want {
			t.Errorf("resolvePath(%q) = %q, want %q", in, got, want)
		}
	}
}

func sampleCandidates() []habackup.Candidate {
	return []habackup.Candidate{
		{Path: "/home/u/Downloads/a1b2c3d4.tar", Size: 1 << 20, IsHA: true},
		{Path: "/home/u/keep/full.tar", Size: 2 << 20},
	}
}

func feedCandidates(m NasUploadModel) NasUploadModel {
	// Clear any creds the dev env may have saved, so selecting a candidate
	// deterministically advances focus rather than submitting (allFilled=false).
	m.ftpUser.SetValue("")
	m.ftpPass.SetValue("")
	mi, _ := m.Update(candidatesMsg{list: sampleCandidates()})
	return mi.(NasUploadModel)
}

func typeNas(m NasUploadModel, s string) NasUploadModel {
	for _, r := range s {
		mi, _ := m.Update(runeKey(r))
		m = mi.(NasUploadModel)
	}
	return m
}

// TestNasUploadPickerShowsAndSelects: a scan populates the list, the View shows
// it on the path field, and Enter fills the path with the highlighted candidate.
func TestNasUploadPickerShowsAndSelects(t *testing.T) {
	m := feedCandidates(NewNasUpload())
	if m.scanning {
		t.Fatal("scanning should clear once candidates arrive")
	}
	if !strings.Contains(m.View(), "a1b2c3d4.tar") {
		t.Error("picker should list discovered candidates on the path field")
	}
	// Enter selects the highlighted (newest) candidate into the path field.
	mi, _ := m.Update(namedKey(tea.KeyEnter))
	m = mi.(NasUploadModel)
	if m.path.Value() != "/home/u/Downloads/a1b2c3d4.tar" {
		t.Fatalf("enter should fill the path from the candidate, got %q", m.path.Value())
	}
	if m.focus != 1 {
		t.Errorf("after selecting, focus should advance to the FTP fields, got %d", m.focus)
	}
}

// TestNasUploadPickerFilters: typing narrows the list to matching paths.
func TestNasUploadPickerFilters(t *testing.T) {
	m := feedCandidates(NewNasUpload())
	m = typeNas(m, "keep")
	if len(m.filtered) != 1 || m.filtered[0].Path != "/home/u/keep/full.tar" {
		t.Fatalf("filter 'keep' should match only full.tar, got %+v", m.filtered)
	}
	// Down then Enter selects within the filtered set.
	mi, _ := m.Update(namedKey(tea.KeyEnter))
	m = mi.(NasUploadModel)
	if m.path.Value() != "/home/u/keep/full.tar" {
		t.Errorf("enter should select the filtered candidate, got %q", m.path.Value())
	}
}
