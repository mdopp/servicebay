package cli

import (
	"fmt"
	"os"

	"sb/internal/rest"
)

// Install implements `sb install status|progress|abort` — the running-job
// commands. (Bare `sb install` opens the interactive stack-install panel,
// handled in main; `sb stacks install` is the non-interactive installer.)
func Install(args []string) int {
	if len(args) == 0 {
		return usageErr(os.Stderr, "usage: sb install status [--json] | progress [--job ID] [--json] | abort [--job ID] --yes")
	}
	switch args[0] {
	case "status":
		return installStatus(args[1:])
	case "progress":
		return installProgress(args[1:])
	case "abort":
		return installAbort(args[1:])
	default:
		return usageErr(os.Stderr, "usage: sb install status [--json] | progress [--job ID] [--json] | abort [--job ID] --yes")
	}
}

func installStatus(args []string) int {
	fs := newFlags("install status")
	jsonMode := fs.Bool("json", false, "machine-readable output")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	client, code := boxClient()
	if client == nil {
		return code
	}
	job, err := client.CurrentInstall(ctx())
	if err != nil {
		return fail(err)
	}
	if job == nil {
		return emit(*jsonMode, map[string]any{"active": false}, func() {
			fmt.Println("No install job running.")
		})
	}
	return emit(*jsonMode, job, func() {
		fmt.Printf("job %s — %s (%d/%d) %s\n", job.ID, job.Phase, job.Deployed, job.Total, job.CurrentItem)
	})
}

func installProgress(args []string) int {
	fs := newFlags("install progress")
	job := fs.String("job", "", "install job id (defaults to the current job)")
	jsonMode := fs.Bool("json", false, "machine-readable output")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	client, code := boxClient()
	if client == nil {
		return code
	}
	jobID, code := resolveJobID(client, *job)
	if code != 0 {
		return code
	}
	prog, err := client.InstallProgress(ctx(), jobID, 0)
	if err != nil {
		return fail(err)
	}
	return emit(*jsonMode, prog, func() {
		fmt.Printf("%s — %d%% (%d/%d) %s\n", prog.Phase, prog.Percent, prog.Deployed, prog.Total, prog.CurrentItem)
		if prog.Error != "" {
			fmt.Printf("error: %s\n", prog.Error)
		}
	})
}

func installAbort(args []string) int {
	fs := newFlags("install abort")
	job := fs.String("job", "", "install job id (defaults to the current job)")
	yes := fs.Bool("yes", false, "confirm the (destructive) abort")
	jsonMode := fs.Bool("json", false, "machine-readable output")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if code := requireYes(*yes, "abort the install"); code != 0 {
		return code
	}
	client, code := boxClient()
	if client == nil {
		return code
	}
	jobID, code := resolveJobID(client, *job)
	if code != 0 {
		return code
	}
	if err := client.AbortInstall(ctx(), jobID); err != nil {
		return fail(err)
	}
	return emit(*jsonMode, map[string]string{"job": jobID, "status": "aborted"}, func() {
		fmt.Printf("✓ aborted job %s\n", jobID)
	})
}

// resolveJobID returns the explicit --job, else the current running job's id,
// or a 2 exit code with a hint when neither is available.
func resolveJobID(client *rest.Client, explicit string) (string, int) {
	if explicit != "" {
		return explicit, 0
	}
	job, err := client.CurrentInstall(ctx())
	if err != nil {
		return "", fail(err)
	}
	if job == nil {
		fmt.Fprintln(os.Stderr, "no running install job — pass --job <id>.")
		return "", 2
	}
	return job.ID, 0
}
