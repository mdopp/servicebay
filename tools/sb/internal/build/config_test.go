package build

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestConfigJSON_Minimal(t *testing.T) {
	c := ConfigBuild{Settings: Settings{ServerName: "OSCAR", ServicebayAdminUser: "admin"}}
	got, err := c.JSON()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := `{
  "serverName": "OSCAR",
  "auth": {
    "username": "admin"
  },
  "autoUpdate": {
    "enabled": true,
    "schedule": "0 0 * * *"
  },
  "templateSettings": {
    "DATA_DIR": "/mnt/data/stacks"
  },
  "setupCompleted": true,
  "stackSetupPending": true
}`
	if string(got) != want {
		t.Errorf("minimal config mismatch:\n got:\n%s\nwant:\n%s", got, want)
	}
}

func TestConfigJSON_FullGolden(t *testing.T) {
	c := ConfigBuild{
		Settings: Settings{
			ServerName:          "OSCAR",
			ServicebayAdminUser: "admin",
			PublicDomain:        "home.example.com",
			GWHost:              "192.168.178.1",
			GWUser:              "fritzadmin",
			EnableRegistries:    "yes",
			EnableOscarRegistry: "Y",
			EnableEmail:         "yes",
			EmailHost:           "smtp.example.com",
			EmailPort:           "587",
			EmailSecure:         "no",
			EmailUser:           "bot@example.com",
			EmailFrom:           "ServiceBay <bot@example.com>",
			EmailRecipients:     "a@example.com, b@example.com ,",
		},
		Secrets:     Secrets{BootstrapTokenHash: "deadbeef"},
		GatewayPass: "gwpass",
		EmailPass:   "smtppass",
	}
	got, err := c.JSON()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := `{
  "serverName": "OSCAR",
  "auth": {
    "username": "admin",
    "bootstrapToken": {
      "hash": "deadbeef",
      "scope": "read"
    }
  },
  "autoUpdate": {
    "enabled": true,
    "schedule": "0 0 * * *"
  },
  "templateSettings": {
    "DATA_DIR": "/mnt/data/stacks"
  },
  "reverseProxy": {
    "publicDomain": "home.example.com"
  },
  "gateway": {
    "type": "fritzbox",
    "host": "192.168.178.1",
    "username": "fritzadmin",
    "password": "gwpass"
  },
  "registries": {
    "enabled": true,
    "items": [
      {
        "name": "ServiceBay Templates",
        "url": "https://github.com/mdopp/servicebay-templates"
      },
      {
        "name": "oscar",
        "url": "https://github.com/mdopp/oscar"
      }
    ]
  },
  "notifications": {
    "email": {
      "enabled": true,
      "host": "smtp.example.com",
      "port": 587,
      "secure": false,
      "user": "bot@example.com",
      "pass": "smtppass",
      "from": "ServiceBay <bot@example.com>",
      "to": [
        "a@example.com",
        "b@example.com"
      ]
    }
  },
  "setupCompleted": true,
  "stackSetupPending": true
}`
	if string(got) != want {
		t.Errorf("full config mismatch:\n got:\n%s\nwant:\n%s", got, want)
	}
	// sanity: it must parse
	var sink map[string]any
	if err := json.Unmarshal(got, &sink); err != nil {
		t.Fatalf("output is not valid JSON: %v", err)
	}
}

func TestConfigJSON_OptionalSectionsOmitted(t *testing.T) {
	// registries off (flags not Y), email off, no gateway, no public domain.
	c := ConfigBuild{Settings: Settings{
		ServerName:          "X",
		ServicebayAdminUser: "admin",
		EnableRegistries:    "no",
		EnableOscarRegistry: "false", // not Y -> off
		EnableEmail:         "0",
	}}
	got, err := c.JSON()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, section := range []string{"reverseProxy", "gateway", "registries", "notifications", "bootstrapToken"} {
		if strings.Contains(string(got), section) {
			t.Errorf("section %q should be omitted:\n%s", section, got)
		}
	}
}

func TestConfigJSON_RegistriesOscarOnly(t *testing.T) {
	c := ConfigBuild{Settings: Settings{
		ServicebayAdminUser: "admin",
		EnableRegistries:    "no",
		EnableOscarRegistry: "yes",
	}}
	got, err := c.JSON()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(string(got), `"oscar"`) || strings.Contains(string(got), "servicebay-templates") {
		t.Errorf("expected oscar-only registries:\n%s", got)
	}
}

func TestConfigJSON_EmailBadPort(t *testing.T) {
	c := ConfigBuild{Settings: Settings{
		ServicebayAdminUser: "admin",
		EnableEmail:         "yes",
		EmailPort:           "not-a-number",
	}}
	if _, err := c.JSON(); err == nil {
		t.Error("expected error for non-numeric EMAIL_PORT when email enabled")
	}
}

func TestConfigJSON_NoHTMLEscape(t *testing.T) {
	// publicDomain / from with characters Go would HTML-escape by default.
	c := ConfigBuild{Settings: Settings{
		ServicebayAdminUser: "admin",
		PublicDomain:        "a&b<c>.example.com",
	}}
	got, err := c.JSON()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(string(got), "a&b<c>.example.com") {
		t.Errorf("expected un-escaped &/</> in output:\n%s", got)
	}
}
