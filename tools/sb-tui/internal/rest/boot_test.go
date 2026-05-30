package rest

import "testing"

func TestAssessUSBBoot(t *testing.T) {
	usb := usbBootEntry{BootNum: "0003", Active: true, Description: "USB HDD"}
	usbInactive := usbBootEntry{BootNum: "0003", Active: false, Description: "USB HDD"}

	cases := []struct {
		name           string
		in             usbBootResponse
		ready, willBoot bool
	}{
		{
			name: "no candidates — USB not detected",
			in:   usbBootResponse{Entries: []usbBootEntry{{BootNum: "0000", Active: true, Description: "Fedora"}}},
		},
		{
			name: "candidate present but inactive",
			in:   usbBootResponse{Candidates: []usbBootEntry{usbInactive}},
		},
		{
			name:  "active candidate, no BootNext — can boot, won't next",
			in:    usbBootResponse{Candidates: []usbBootEntry{usb}},
			ready: true,
		},
		{
			name:     "active candidate + BootNext set to it — will boot next",
			in:       usbBootResponse{Candidates: []usbBootEntry{usb}, BootNext: "0003"},
			ready:    true,
			willBoot: true,
		},
		{
			name:  "BootNext points elsewhere — ready but won't boot USB next",
			in:    usbBootResponse{Candidates: []usbBootEntry{usb}, BootNext: "0000"},
			ready: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := assessUSBBoot(tc.in)
			if !got.Known {
				t.Errorf("Known = false, want true (assess always knows)")
			}
			if got.Ready != tc.ready {
				t.Errorf("Ready = %v, want %v (summary: %q)", got.Ready, tc.ready, got.Summary)
			}
			if got.WillBoot != tc.willBoot {
				t.Errorf("WillBoot = %v, want %v", got.WillBoot, tc.willBoot)
			}
			if got.Summary == "" {
				t.Errorf("Summary is empty")
			}
		})
	}
}
