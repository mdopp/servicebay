package cli

import (
	"fmt"
	"os"
)

// Boot implements `sb boot usb-status|usb-enable`.
func Boot(args []string) int {
	if len(args) == 0 {
		return usageErr(os.Stderr, "usage: sb boot usb-status [--json] | usb-enable --yes")
	}
	switch args[0] {
	case "usb-status":
		return bootUSBStatus(args[1:])
	case "usb-enable":
		return bootUSBEnable(args[1:])
	default:
		return usageErr(os.Stderr, "usage: sb boot usb-status [--json] | usb-enable --yes")
	}
}

func bootUSBStatus(args []string) int {
	fs := newFlags("boot usb-status")
	jsonMode := fs.Bool("json", false, "machine-readable output")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	client, code := boxClient()
	if client == nil {
		return code
	}
	st, err := client.USBBootStatus(ctx())
	if err != nil {
		return fail(err)
	}
	return emit(*jsonMode, st, func() {
		fmt.Println(st.Summary)
	})
}

func bootUSBEnable(args []string) int {
	fs := newFlags("boot usb-enable")
	yes := fs.Bool("yes", false, "confirm the (destructive) reboot-to-USB")
	jsonMode := fs.Bool("json", false, "machine-readable output")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if code := requireYes(*yes, "set one-shot USB boot and reboot the box"); code != 0 {
		return code
	}
	client, code := boxClient()
	if client == nil {
		return code
	}
	msg, err := client.EnableUSBBoot(ctx())
	if err != nil {
		return fail(err)
	}
	return emit(*jsonMode, map[string]string{"status": "usb-boot-set", "message": msg}, func() {
		fmt.Println(msg)
	})
}
