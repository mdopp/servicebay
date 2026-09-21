---
title: A file you wrote on the host is not automatically a file your container can read
whenToUse: A container serves 404 or "no such file" for a file you know you put there, a hostPath mount looks empty or stale from inside the container while read_file/ls shows the file fine from outside, or you are about to conclude "the hostPath volume mount is not picking up the files" — read this before rewriting the mount, the pod spec, or the deploy.
kind: footgun
tags: [selinux, mcs, hostpath, volumes, write_file, podman, permissions, agent, troubleshooting]
---

# A file you wrote on the host is not automatically a file your container can read

Ownership is not the only gate. On a SELinux box (Fedora CoreOS, and therefore
this one), every container runs with its own **MCS category pair**, and every
file it creates inherits those categories:

```
unconfined_u:object_r:container_file_t:s0:c1022,c1023
                                        ^^^^^^^^^^^ these
```

A *different* container mounting that path through `hostPath` has a different
category pair, so the kernel denies it. Nothing about this looks like a
permissions problem from either side:

- from the writer, `ls`, `stat` and a read-back all succeed — the writing
  process is the one process whose categories match;
- from the reader, the file is simply **not there**: a 404, an empty directory
  listing, a config that "did not take".

That asymmetry is the whole footgun. It reads exactly like a broken mount, and
the obvious next moves — rewrite the `hostPath`, change the mount path, redeploy
— all leave it broken.

## The one-line check

```sh
ls -Z <path>        # or: stat -c %C <path>
```

If the label ends in `:c<number>,c<number>`, no other container will read it.
If it ends in plain `:s0`, any container will.

## The fix

```sh
chcon -l s0 <path>          # one file
chcon -R -l s0 <directory>  # a tree
```

This drops the categories while leaving type and user alone, which is what you
want for a file whose entire purpose is to be mounted by another service.

## What already does this for you

`write_file` (MCP) clears the categories itself and **reports the label it read
back off disk** (#2996):

```json
{ "path": "…", "bytes": 792, "ownershipSet": true, "label": "unconfined_u:object_r:container_file_t:s0" }
```

If you see a `labelWarning` in that answer, the categories survived and the
consumer will not see the file — that is the message to act on, not the `bytes`
count next to it.

Files written **before** that fix, and files created by anything else running in
a container, still carry categories. So does a checkout ServiceBay refreshes:
the agent-kit tree needs `chcon -R -l s0` again after a restart recreates it,
which is why a session can lose the catalog with no other symptom.

## Why it is not simply off

The categories are real isolation: they are what stops one service reading
another's data through a shared host path. Clearing them is right for a file
that *exists to be shared* — a config, an asset, a checkout several services
read — and wrong as a blanket habit. Clear the specific path, not the data root.

## Before you conclude the mount is broken

Check the label first. It costs one command and it is the difference between a
five-second fix and rebuilding a deployment around a working mount.
