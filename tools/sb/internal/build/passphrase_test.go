package build

import (
	"bytes"
	"strconv"
	"strings"
	"testing"
)

func TestPassphraseShape(t *testing.T) {
	p, err := Passphrase(bytes.NewReader([]byte{3, 9, 40, 77, 55}))
	if err != nil {
		t.Fatalf("Passphrase: %v", err)
	}
	parts := strings.Split(p, "-")
	if len(parts) != 5 {
		t.Fatalf("want 4 words + a number (5 hyphen parts), got %q", p)
	}
	n, err := strconv.Atoi(parts[4])
	if err != nil || n < 10 || n > 99 {
		t.Errorf("trailing segment %q is not a 2-digit number", parts[4])
	}
	if pipelineUnsafe(p) || p != strings.ToLower(p) {
		t.Errorf("passphrase %q must be lowercase + pipeline-safe", p)
	}
}
