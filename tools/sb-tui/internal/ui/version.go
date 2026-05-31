package ui

// Version is the released ServiceBay version this build carries, shown in the
// launcher footer. main sets it from its own -ldflags-injected version at
// startup; it defaults to "dev" for local builds.
var Version = "dev"
