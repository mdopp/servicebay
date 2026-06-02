package cli

import (
	"fmt"
	"os"
)

// Backups implements `sb backups list|create|restore`. (Bare `sb backups` opens
// the interactive panel, handled in main.)
func Backups(args []string) int {
	if len(args) == 0 {
		return usageErr(os.Stderr, "usage: sb backups list [--json] | create [--json] | restore --file NAME --yes")
	}
	switch args[0] {
	case "list":
		return backupsList(args[1:])
	case "create":
		return backupsCreate(args[1:])
	case "restore":
		return backupsRestore(args[1:])
	default:
		return usageErr(os.Stderr, "usage: sb backups list [--json] | create [--json] | restore --file NAME --yes")
	}
}

func backupsList(args []string) int {
	fs := newFlags("backups list")
	jsonMode := fs.Bool("json", false, "machine-readable output")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	client, code := boxClient()
	if client == nil {
		return code
	}
	backups, err := client.ListBackups(ctx())
	if err != nil {
		return fail(err)
	}
	return emit(*jsonMode, backups, func() {
		if len(backups) == 0 {
			fmt.Println("No system backups.")
			return
		}
		for _, b := range backups {
			fmt.Printf("%-40s %10d bytes  %s\n", b.FileName, b.Size, b.CreatedAt)
		}
	})
}

func backupsCreate(args []string) int {
	fs := newFlags("backups create")
	jsonMode := fs.Bool("json", false, "machine-readable output")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	client, code := boxClient()
	if client == nil {
		return code
	}
	b, err := client.CreateBackup(ctx())
	if err != nil {
		return fail(err)
	}
	return emit(*jsonMode, b, func() {
		fmt.Printf("✓ created %s (%d bytes)\n", b.FileName, b.Size)
	})
}

func backupsRestore(args []string) int {
	fs := newFlags("backups restore")
	file := fs.String("file", "", "backup file name to restore (see `sb backups list`)")
	yes := fs.Bool("yes", false, "confirm the (destructive) restore")
	jsonMode := fs.Bool("json", false, "machine-readable output")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *file == "" {
		return usageErr(os.Stderr, "backups restore: --file is required")
	}
	if code := requireYes(*yes, "restore "+*file); code != 0 {
		return code
	}
	client, code := boxClient()
	if client == nil {
		return code
	}
	if err := client.RestoreBackup(ctx(), *file); err != nil {
		return fail(err)
	}
	return emit(*jsonMode, map[string]string{"file": *file, "status": "restored"}, func() {
		fmt.Printf("✓ restored %s\n", *file)
	})
}
