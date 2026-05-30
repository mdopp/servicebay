package rest

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
)

// usbBootEntry is one UEFI boot entry as reported by the box's usb-next GET
// (parsed from `efibootmgr -v` server-side).
type usbBootEntry struct {
	BootNum     string `json:"bootNum"`
	Active      bool   `json:"active"`
	Description string `json:"description"`
	Current     bool   `json:"current"`
}

// usbBootResponse is the GET /api/system/boot/usb-next payload.
type usbBootResponse struct {
	Entries    []usbBootEntry `json:"entries"`
	Candidates []usbBootEntry `json:"candidates"`
	BootNext   string         `json:"bootNext"`
	BootOrder  []string       `json:"bootOrder"`
}

// USBBootReadiness summarises whether the box can / will boot from USB, for the
// status row shown beside ping + webserver.
type USBBootReadiness struct {
	// Known is false when the box couldn't be queried (gray dot).
	Known bool
	// Ready: an ACTIVE USB/removable UEFI entry exists → firmware CAN boot USB.
	Ready bool
	// WillBoot: BootNext points at a USB candidate → the NEXT boot is from USB.
	WillBoot bool
	// Summary is the one-line human status for the dashboard row.
	Summary string
}

// assessUSBBoot derives readiness from the box's usb-next payload. Pure; mirrors
// assessUsbBootReadiness in packages/backend/.../mcp/efibootmgr.ts (Ready ==
// "reinstallReady": at least one removable/USB entry that is active).
func assessUSBBoot(r usbBootResponse) USBBootReadiness {
	activeCandidates := 0
	for _, c := range r.Candidates {
		if c.Active {
			activeCandidates++
		}
	}
	willBoot := false
	if r.BootNext != "" {
		for _, c := range r.Candidates {
			if strings.EqualFold(strings.TrimSpace(c.BootNum), strings.TrimSpace(r.BootNext)) {
				willBoot = true
				break
			}
		}
	}
	switch {
	case len(r.Candidates) == 0:
		return USBBootReadiness{Known: true, Summary: "no USB boot entry — insert the install USB"}
	case activeCandidates == 0:
		return USBBootReadiness{Known: true, Summary: "USB entry present but inactive — enable it"}
	case willBoot:
		return USBBootReadiness{Known: true, Ready: true, WillBoot: true, Summary: "will boot from USB on next reboot"}
	default:
		return USBBootReadiness{Known: true, Ready: true, Summary: "can boot from USB (enable to use it next reboot)"}
	}
}

// USBBootStatus queries the box for its UEFI boot entries and returns whether it
// can / will boot from USB. Uses the scoped token (GET needs 'read').
func (c *Client) USBBootStatus(ctx context.Context) (USBBootReadiness, error) {
	raw, err := c.do(ctx, http.MethodGet, "/api/system/boot/usb-next", nil)
	if err != nil {
		return USBBootReadiness{}, err
	}
	var r usbBootResponse
	if err := json.Unmarshal(raw, &r); err != nil {
		return USBBootReadiness{}, &APIError{Message: err.Error()}
	}
	return assessUSBBoot(r), nil
}

// EnableUSBBoot activates the box's USB boot entry and sets a one-shot UEFI
// BootNext WITHOUT rebooting (reboot:false), so the operator confirms before the
// box restarts. Uses the scoped token (POST needs 'mutate'). Returns the box's
// confirmation message.
func (c *Client) EnableUSBBoot(ctx context.Context) (string, error) {
	raw, err := c.do(ctx, http.MethodPost, "/api/system/boot/usb-next", map[string]any{"reboot": false})
	if err != nil {
		return "", err
	}
	var out struct {
		Message string `json:"message"`
	}
	_ = json.Unmarshal(raw, &out)
	if strings.TrimSpace(out.Message) == "" {
		out.Message = "One-shot USB boot set for the next reboot."
	}
	return out.Message, nil
}
