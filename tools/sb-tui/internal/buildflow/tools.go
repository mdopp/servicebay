package buildflow

import "os/exec"

// requiredTools are the build-host executables the native ISO build shells out
// to: openssl (password hash), ssh-keygen (container->host key), butane
// (Butane->Ignition), coreos-installer (ISO customise + download).
var requiredTools = []string{"openssl", "ssh-keygen", "butane", "coreos-installer"}

// MissingTools returns the required build-host tools not found on PATH, so the
// caller can fail fast with an actionable message before starting the wizard.
func MissingTools() []string {
	var missing []string
	for _, t := range requiredTools {
		if _, err := exec.LookPath(t); err != nil {
			missing = append(missing, t)
		}
	}
	return missing
}
