// The Bubble Tea model for the update-channel panel: show which release
// channel the server is running and switch it (latest / dev / test). Switching
// re-points the box's ServiceBay image and restarts it, so the panel polls
// until the box is back on the chosen channel. Mainly lets an operator try an
// unreleased `:dev` build without a full reinstall; mirrors the edit-config /
// install panels' shape and reuses the #1275 token client.
package ui

import (
	"context"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"sb/internal/rest"
)

type channelStage int

const (
	chanLoading channelStage = iota
	chanSelect
	chanSwitching
	chanDone
	chanError
)

const chanMaxPolls = 40 // ~80s at 2s/poll — covers a cold image pull + restart

// ChannelModel is the Bubble Tea model for the update-channel panel.
type ChannelModel struct {
	client        *rest.Client
	width, height int
	stage         channelStage
	current       string   // channel actually running now
	choices       []string // rest.Channels
	cursor        int
	target        string // channel being switched to
	polls         int
	errMsg        string
}

type channelLoadedMsg struct {
	channel string
	err     error
}
type channelSetMsg struct{ err error }
type channelPollMsg struct {
	channel string
	err     error
}
type channelTickMsg struct{}

// NewChannel builds the update-channel model against an authenticated client.
func NewChannel(client *rest.Client) ChannelModel {
	return ChannelModel{client: client, stage: chanLoading, choices: rest.Channels}
}

func (m ChannelModel) loadCmd() tea.Cmd {
	client := m.client
	return func() tea.Msg {
		ch, err := client.GetChannel(context.Background())
		return channelLoadedMsg{channel: ch, err: err}
	}
}

func (m ChannelModel) setCmd(target string) tea.Cmd {
	client := m.client
	return func() tea.Msg { return channelSetMsg{err: client.SetChannel(context.Background(), target)} }
}

func (m ChannelModel) pollCmd() tea.Cmd {
	client := m.client
	return func() tea.Msg {
		ch, err := client.GetChannel(context.Background())
		return channelPollMsg{channel: ch, err: err}
	}
}

func tick2s() tea.Cmd {
	return tea.Tick(2*time.Second, func(time.Time) tea.Msg { return channelTickMsg{} })
}

// Init reads the current channel.
func (m ChannelModel) Init() tea.Cmd { return m.loadCmd() }

// Update folds in load/set/poll results and handles input.
func (m ChannelModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case channelLoadedMsg:
		if msg.err != nil {
			m.stage, m.errMsg = chanError, friendlyErr(msg.err)
			if msg.err == rest.ErrUnauthorized {
				return m, reauthCmd()
			}
			return m, nil
		}
		m.current, m.stage = msg.channel, chanSelect
		for i, c := range m.choices {
			if c == m.current {
				m.cursor = i
			}
		}
		return m, nil
	case channelSetMsg:
		if msg.err != nil {
			m.stage, m.errMsg = chanError, friendlyErr(msg.err)
			if msg.err == rest.ErrUnauthorized {
				return m, reauthCmd()
			}
			return m, nil
		}
		return m, tick2s() // the box is restarting; start polling for the flip
	case channelTickMsg:
		return m, m.pollCmd()
	case channelPollMsg:
		m.polls++
		if msg.err == nil && msg.channel == m.target {
			m.current, m.stage = msg.channel, chanDone
			return m, nil
		}
		if m.polls >= chanMaxPolls {
			m.stage, m.errMsg = chanError, "Timed out waiting for the server to come back — it may still be restarting. Reopen this panel to check."
			return m, nil
		}
		return m, tick2s()
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		return m, nil
	case backMsg:
		return m, tea.Quit // standalone-only; App intercepts when hosted
	case tea.KeyMsg:
		return m.handleKey(msg)
	}
	return m, nil
}

func (m ChannelModel) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "ctrl+c":
		return m, tea.Quit
	case "q", "esc":
		// Don't bail mid-switch (the box is restarting); otherwise pop back.
		if m.stage != chanSwitching {
			return m, backCmd()
		}
	}
	if m.stage != chanSelect {
		return m, nil
	}
	switch msg.String() {
	case "up", "k":
		m.cursor = (m.cursor - 1 + len(m.choices)) % len(m.choices)
	case "down", "j":
		m.cursor = (m.cursor + 1) % len(m.choices)
	case "enter":
		m.target = m.choices[m.cursor]
		if m.target == m.current {
			return m, backCmd() // already on it — nothing to do
		}
		m.stage = chanSwitching
		return m, m.setCmd(m.target)
	}
	return m, nil
}

// View renders the panel per stage.
func (m ChannelModel) View() string {
	width := m.width
	if width <= 0 {
		width = 72
	}
	var b strings.Builder
	b.WriteString(titleStyle.Width(width).Render("ServiceBay  ·  update channel") + "\n")

	switch m.stage {
	case chanLoading:
		b.WriteString(phaseStyle.Render("Reading the current channel…"))
	case chanError:
		b.WriteString(phaseStyle.Render(cfgErrStyle.Render("Channel error:")) + "\n")
		b.WriteString(detailStyle.Render(m.errMsg) + "\n")
		b.WriteString(footerStyle.Render("q back"))
	case chanSelect:
		b.WriteString(phaseStyle.Render("Pick the channel this server runs. `dev` = the latest unreleased build; switching pulls the image and restarts ServiceBay.") + "\n\n")
		for i, c := range m.choices {
			suffix := ""
			if c == m.current {
				suffix = cfgEmptyStyle.Render("  (current)")
			}
			if i == m.cursor {
				b.WriteString(selectedStyle.Render("❯ "+c) + suffix + "\n")
			} else {
				b.WriteString("  " + c + suffix + "\n")
			}
		}
		b.WriteString("\n" + footerStyle.Render("↑/↓ move · enter switch · q back"))
	case chanSwitching:
		b.WriteString(phaseStyle.Render("Switching to '"+m.target+"' — pulling the image and restarting ServiceBay…") + "\n")
		b.WriteString(detailStyle.Render("The server drops briefly during the restart; waiting for it to come back on the new channel."))
	case chanDone:
		b.WriteString(phaseStyle.Render(cfgOKStyle.Render("✓ ServiceBay is now on '"+m.current+"'.")) + "\n")
		b.WriteString(footerStyle.Render("q back"))
	}
	return frame(b.String(), m.width, m.height)
}
