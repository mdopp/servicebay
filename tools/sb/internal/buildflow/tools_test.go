package buildflow

import (
	"errors"
	"strings"
	"testing"
)

func TestButaneDownloadURL(t *testing.T) {
	if got := butaneDownloadURL("amd64"); got != "https://github.com/coreos/butane/releases/latest/download/butane-x86_64-unknown-linux-gnu" {
		t.Errorf("amd64 URL = %q", got)
	}
	if got := butaneDownloadURL("arm64"); !strings.Contains(got, "butane-aarch64-unknown-linux-gnu") {
		t.Errorf("arm64 URL = %q, want aarch64 asset", got)
	}
}

func lookOnly(present ...string) func(string) (string, error) {
	set := map[string]bool{}
	for _, p := range present {
		set[p] = true
	}
	return func(cmd string) (string, error) {
		if set[cmd] {
			return "/usr/bin/" + cmd, nil
		}
		return "", errors.New("not found")
	}
}

func TestDetectPkgManager(t *testing.T) {
	cases := []struct {
		present  []string
		wantName string
		sshPkg   string
	}{
		{[]string{"dnf"}, "dnf", "openssh-clients"},
		{[]string{"apt-get"}, "apt-get", "openssh-client"},
		{[]string{"pacman"}, "pacman", "openssh"},
		{[]string{"zypper"}, "zypper", "openssh"},
		{[]string{"dnf", "apt-get"}, "dnf", "openssh-clients"}, // dnf wins (ordered)
	}
	for _, tc := range cases {
		pm := detectPkgManager(lookOnly(tc.present...))
		if pm == nil || pm.name != tc.wantName {
			t.Fatalf("present %v → %v, want %s", tc.present, pm, tc.wantName)
		}
		if got := pm.toolPackage("ssh-keygen"); got != tc.sshPkg {
			t.Errorf("%s ssh-keygen pkg = %q, want %q", pm.name, got, tc.sshPkg)
		}
		// Tools without a distro-specific name map to themselves.
		if got := pm.toolPackage("openssl"); got != "openssl" {
			t.Errorf("%s openssl pkg = %q, want openssl", pm.name, got)
		}
	}
	if pm := detectPkgManager(lookOnly("brew" /* unsupported */)); pm != nil {
		t.Errorf("no supported manager → want nil, got %v", pm)
	}
}
