package ui

import (
	"strings"
	"testing"

	"servicebay-tui/internal/rest"
)

func loadedBackupModel() BackupModel {
	m := NewBackup(&rest.Client{})
	mi, _ := m.Update(backupsLoadedMsg{backups: []rest.Backup{
		{FileName: "a.tar.gz", CreatedAt: "t1", Size: 1024},
		{FileName: "b.tar.gz", CreatedAt: "t2", Size: 2048},
	}})
	return mi.(BackupModel)
}

func TestBackupRestoreRequiresConfirmation(t *testing.T) {
	m := loadedBackupModel()
	if m.stage != bkBrowse {
		t.Fatalf("stage = %v", m.stage)
	}
	// 'r' must NOT restore immediately — it enters the confirm stage.
	mi, cmd := m.Update(runeKey('r'))
	m = mi.(BackupModel)
	if m.stage != bkConfirm || cmd != nil {
		t.Fatalf("r should open confirm with no command, stage=%v", m.stage)
	}
	if !strings.Contains(m.View(), "OVERWRITES") {
		t.Error("confirm view must warn about overwrite")
	}
	// 'n' cancels back to browse without restoring.
	mi, cmd = m.Update(runeKey('n'))
	m = mi.(BackupModel)
	if m.stage != bkBrowse || cmd != nil {
		t.Fatalf("n should cancel, stage=%v", m.stage)
	}
}

func TestBackupConfirmYesRestores(t *testing.T) {
	m := loadedBackupModel()
	mi, _ := m.Update(runeKey('r'))
	m = mi.(BackupModel)
	mi, cmd := m.Update(runeKey('y'))
	m = mi.(BackupModel)
	if m.stage != bkRestoring || cmd == nil {
		t.Fatalf("y should start restore, stage=%v cmd=%v", m.stage, cmd)
	}
	// Restore result returns to browse with a status.
	mi, _ = m.Update(backupRestoredMsg{fileName: "a.tar.gz"})
	m = mi.(BackupModel)
	if m.stage != bkBrowse || !strings.Contains(m.status, "restored") {
		t.Fatalf("after restore: stage=%v status=%q", m.stage, m.status)
	}
}

func TestBackupCreateRefreshesList(t *testing.T) {
	m := loadedBackupModel()
	mi, cmd := m.Update(runeKey('n'))
	m = mi.(BackupModel)
	if m.stage != bkCreating || cmd == nil {
		t.Fatalf("n should start creating, stage=%v", m.stage)
	}
	// A successful create returns to browse and re-loads the list.
	mi, cmd = m.Update(backupCreatedMsg{backup: &rest.Backup{FileName: "new.tar.gz"}})
	m = mi.(BackupModel)
	if m.stage != bkBrowse || cmd == nil { // cmd == loadCmd refresh
		t.Fatalf("create done should refresh, stage=%v cmd=%v", m.stage, cmd)
	}
	if !strings.Contains(m.status, "created") {
		t.Errorf("status = %q", m.status)
	}
}

func TestBackupLoadErrorBlocks(t *testing.T) {
	m := NewBackup(&rest.Client{})
	mi, _ := m.Update(backupsLoadedMsg{err: rest.ErrUnauthorized})
	m = mi.(BackupModel)
	if m.loadEr == nil || !strings.Contains(m.View(), "token") {
		t.Fatal("auth load error should block with a token hint")
	}
}

func TestHumanSize(t *testing.T) {
	cases := map[int64]string{512: "512 B", 2048: "2.0 KiB", 5242880: "5.0 MiB"}
	for in, want := range cases {
		if got := humanSize(in); got != want {
			t.Errorf("humanSize(%d) = %q, want %q", in, got, want)
		}
	}
}
