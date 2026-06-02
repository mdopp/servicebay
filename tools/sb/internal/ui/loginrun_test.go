package ui

import "testing"

func TestLoginRunnerCapturesToken(t *testing.T) {
	r := loginRunner{login: NewLogin("h", "5888")}
	mi, cmd := r.Update(authSucceededMsg{token: "sb_abc"})
	rr := mi.(loginRunner)
	if !rr.ok || rr.token != "sb_abc" {
		t.Fatalf("authSucceeded should capture the token: ok=%v token=%q", rr.ok, rr.token)
	}
	if cmd == nil {
		t.Fatal("should quit after capturing the token")
	}
}

func TestLoginRunnerCancel(t *testing.T) {
	r := loginRunner{login: NewLogin("h", "5888")}
	mi, cmd := r.Update(backMsg{})
	rr := mi.(loginRunner)
	if rr.ok || rr.token != "" {
		t.Fatalf("backMsg should cancel with no token: ok=%v token=%q", rr.ok, rr.token)
	}
	if cmd == nil {
		t.Fatal("should quit on cancel")
	}
}
