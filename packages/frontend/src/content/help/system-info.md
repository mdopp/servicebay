# System Info

## Goal
Overview of the host system resources.

## Key Functions
- **Resources**: CPU, Memory, and Disk usage.
- **OS Info**: Kernel version, uptime, and hostname.
- **Network**: Interface statistics and IP addresses.
- **Multi-Server**: View statistics for Local and configured remote nodes.
- **Update Channel**: Check whether ServiceBay itself has an update pending before you schedule downtime.

## Tips
- Snapshot resource graphs right after running a System Backup so you can compare trends before and after changes.
- Watch disk pressure on `/mnt/data`—if it spikes, consider pruning stacks or expanding storage before the next backup cycle.
