#!/usr/bin/env bash
#
# Regression test for templates/claude-dev/docker-entrypoint.sh (#2418).
#
# The entrypoint's boot autostart discovers git checkouts under /workspace —
# a directory that is group-writable by every `devshare` member, i.e. by every
# non-admin LDAP collaborator — and hands the basenames to `start-claude`
# through `su`. It used to splice them into a string `su -c` re-parsed as
# shell, so a directory named `$(...)` executed as the shared `dev` account on
# the next container start.
#
# This suite sources the entrypoint with CLAUDE_DEV_ENTRYPOINT_LIB=1 (which
# stops before the root-only boot sequence, leaving the helpers defined) and
# exercises those helpers against a fake workspace full of hostile directory
# names, with `su` / `start-claude` / `ldapsearch` stubbed on PATH.
#
# Run directly:  bash tests/templates/claude_dev_entrypoint_test.sh
# Run via CI:    npm test  (wrapped by tests/backend/claude_dev_entrypoint.test.ts)

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENTRYPOINT="$REPO_ROOT/templates/claude-dev/docker-entrypoint.sh"

FAILURES=0
CASES=0

pass() { CASES=$((CASES + 1)); echo "ok   - $1"; }
fail() {
  CASES=$((CASES + 1))
  FAILURES=$((FAILURES + 1))
  echo "FAIL - $1"
  [ $# -gt 1 ] && printf '       %s\n' "${@:2}"
  return 0
}
check() { # check <desc> <cond-result 0/1> [detail...]
  local desc="$1" rc="$2"; shift 2
  if [ "$rc" -eq 0 ]; then pass "$desc"; else fail "$desc" "$@"; fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

STUB_BIN="$WORK/bin"
RECORD="$WORK/record"
MARKERS="$WORK/markers"
mkdir -p "$STUB_BIN" "$RECORD" "$MARKERS"

# --- the fake shared workspace -------------------------------------------
# Hostile names first. Each payload writes into $MARKERS; if any of these
# files exists at the end of a case, some shell evaluated a directory name.
DEV_HOME_FAKE="$WORK/workspace"
mkdir -p "$DEV_HOME_FAKE"

# A filename cannot contain `/`, so the payloads are relative `touch`es. The
# test process cds into $MARKERS and the su'd shell cds into $DEV_HOME, so an
# evaluated payload lands in one of those two — both under $WORK, which the
# leak check sweeps.
MAL_CMDSUB='$(touch pwned-cmdsub)'
MAL_BACKTICK='`touch pwned-backtick`'
MAL_SEMI='repo; touch pwned-semi'
MAL_SUOPT='-c'                       # su's own --command, via permuting getopt
MAL_SUOPT_VAL='touch pwned-suopt'    # …and the value it would swallow

REPO_NAMES=(
  "$MAL_CMDSUB"
  "$MAL_BACKTICK"
  "$MAL_SEMI"
  "$MAL_SUOPT"
  "$MAL_SUOPT_VAL"
  'normal-repo'
  'another repo with spaces'
)
for name in "${REPO_NAMES[@]}"; do
  mkdir -p "$DEV_HOME_FAKE/$name"
  : > "$DEV_HOME_FAKE/$name/.git"
done
# Decoys that must NOT be picked up.
mkdir -p "$DEV_HOME_FAKE/not-a-repo" "$DEV_HOME_FAKE/home/someuser" "$DEV_HOME_FAKE/.claude"
: > "$DEV_HOME_FAKE/.claude/.git"    # hidden — skipped by the */ glob

# --- stubs ----------------------------------------------------------------
# `su` stub. It deliberately MODELS util-linux su: a permuting getopt (options
# are still recognised after the user operand, until `--`), then
# `<shell> -c <command> <remaining args...>`. Modelling the re-parse is the
# whole point — a stub that just recorded argv would pass on the vulnerable
# code too. The `real su permutes` case below pins this model against the
# actual su binary so it cannot drift.
cat > "$STUB_BIN/su" <<'STUB'
#!/usr/bin/env bash
shell=/bin/bash
command=
user=
args=()
end_of_opts=0
while [ $# -gt 0 ]; do
  if [ "$end_of_opts" -eq 0 ]; then
    case "$1" in
      --) end_of_opts=1; shift; continue;;
      -c|--command) command="$2"; shift 2; continue;;
      -s|--shell)   shell="$2";   shift 2; continue;;
      -*) shift; continue;;
    esac
  fi
  if [ -z "$user" ]; then user="$1"; else args+=("$1"); fi
  shift
done
printf '%s\0' "SU_USER=$user" "SU_SHELL=$shell" "SU_COMMAND=$command" >> "$SU_RECORD"
printf '%s\0' "${args[@]}" >> "$SU_ARGS_RECORD"
exec "$shell" -c "$command" "${args[@]}"
STUB

# `start-claude` stub — records the argv it was handed, NUL-delimited, so a
# name containing a newline or a space is still one unambiguous element.
cat > "$STUB_BIN/start-claude" <<'STUB'
#!/usr/bin/env bash
printf '%s\0' "$@" >> "$SC_ARGS_RECORD"
printf '%s\0' "PWD=$PWD" "HOME=$HOME" "NO_ATTACH=${CLAUDE_START_NO_ATTACH:-}" >> "$SC_ENV_RECORD"
STUB

# `ldapsearch` stub — records argv plus, for a `-y` file, its mode and
# contents at the moment of the call (the entrypoint deletes it afterwards).
cat > "$STUB_BIN/ldapsearch" <<'STUB'
#!/usr/bin/env bash
printf '%s\0' "$@" >> "$LS_ARGS_RECORD"
prev=
for a in "$@"; do
  if [ "$prev" = "-y" ]; then
    printf '%s\0' "PWFILE=$a" "PWMODE=$(stat -c '%a' "$a" 2>/dev/null)" \
                  "PWCONTENT=$(cat "$a" 2>/dev/null)" >> "$LS_PWFILE_RECORD"
  fi
  prev="$a"
done
cat <<'LDIF'
dn: cn=devs,ou=groups,dc=example,dc=test
member: uid=alice,ou=people,dc=example,dc=test
member: uid=bob,ou=people,dc=example,dc=test
LDIF
STUB

chmod +x "$STUB_BIN/su" "$STUB_BIN/start-claude" "$STUB_BIN/ldapsearch"

export SU_RECORD="$RECORD/su.txt"
export SU_ARGS_RECORD="$RECORD/su-args.txt"
export SC_ARGS_RECORD="$RECORD/start-claude-args.txt"
export SC_ENV_RECORD="$RECORD/start-claude-env.txt"
export LS_ARGS_RECORD="$RECORD/ldapsearch-args.txt"
export LS_PWFILE_RECORD="$RECORD/ldapsearch-pwfile.txt"

read_nul() { # read_nul <file> -> lines on stdout, one record per line
  [ -f "$1" ] || return 0
  tr '\0' '\n' < "$1"
}

# --- source the entrypoint as a library -----------------------------------
CLAUDE_DEV_ENTRYPOINT_LIB=1
export CLAUDE_DEV_ENTRYPOINT_LIB
# shellcheck source=../../templates/claude-dev/docker-entrypoint.sh
# shellcheck disable=SC1090
source "$ENTRYPOINT"
set +e   # the entrypoint sets -euo pipefail; assertions need to keep going

check "sourcing guard leaves the helpers defined without running the boot sequence" \
  "$( { declare -F discover_repos autostart_claude su_dev ldap_group_members >/dev/null; } && echo 0 || echo 1)"

DEV_HOME="$DEV_HOME_FAKE"
PATH="$STUB_BIN:$PATH"
cd "$MARKERS" || exit 1   # any payload evaluated by THIS shell lands under $WORK

# =========================================================================
# 1. discover_repos picks up exactly the real checkouts, names intact
# =========================================================================
repos=()
discover_repos

expected="$(printf '%s\n' "${REPO_NAMES[@]}" | LC_ALL=C sort)"
actual="$(printf '%s\n' "${repos[@]}" | LC_ALL=C sort)"
check "discover_repos finds every .git checkout and nothing else" \
  "$([ "$expected" = "$actual" ] && echo 0 || echo 1)" \
  "expected: $(printf '%s' "$expected" | tr '\n' '|')" \
  "actual:   $(printf '%s' "$actual" | tr '\n' '|')"

# =========================================================================
# 2. THE FIX: a hostile checkout name reaches start-claude as ONE literal
#    argv element and no shell ever evaluates it.
# =========================================================================
autostart_claude "${repos[@]}"
autostart_rc=$?

check "autostart_claude exits 0 on a normal boot" \
  "$([ "$autostart_rc" -eq 0 ] && echo 0 || echo 1)" "exit=$autostart_rc"

leaked="$(find "$WORK" -name 'pwned-*' 2>/dev/null | tr '\n' ' ')"
check "no payload from a directory name ever executed" \
  "$([ -z "$leaked" ] && echo 0 || echo 1)" \
  "marker files created: $leaked"

sc_args="$(read_nul "$SC_ARGS_RECORD")"
check "start-claude was invoked" \
  "$([ -n "$sc_args" ] && echo 0 || echo 1)"

for name in "${REPO_NAMES[@]}"; do
  check "repo name is one literal argv element: [$name]" \
    "$(grep -Fqx -- "$name" <<<"$sc_args" && echo 0 || echo 1)" \
    "recorded argv: $(printf '%s' "$sc_args" | tr '\n' '|')"
done

# The count must match exactly — a re-parse would split one name into several
# words, or drop one into su's option slot.
sc_repo_count="$(sed -n '/^--$/,$p' <<<"$sc_args" | tail -n +2 | grep -c '')"
check "start-claude got exactly ${#REPO_NAMES[@]} repo arguments after the -- separator" \
  "$([ "$sc_repo_count" -eq "${#REPO_NAMES[@]}" ] && echo 0 || echo 1)" \
  "got $sc_repo_count"

check "the pass-through claude flags survived" \
  "$(grep -Fqx -- '--continue' <<<"$sc_args" \
     && grep -Fqx -- '--allow-dangerously-skip-permissions' <<<"$sc_args" \
     && grep -Fqx -- '--' <<<"$sc_args" && echo 0 || echo 1)"

sc_env="$(read_nul "$SC_ENV_RECORD")"
check "start-claude ran in \$DEV_HOME with HOME=\$DEV_HOME and no-attach set" \
  "$(grep -Fqx -- "PWD=$DEV_HOME" <<<"$sc_env" \
     && grep -Fqx -- "HOME=$DEV_HOME" <<<"$sc_env" \
     && grep -Fqx -- 'NO_ATTACH=1' <<<"$sc_env" && echo 0 || echo 1)" \
  "recorded: $(printf '%s' "$sc_env" | tr '\n' '|')"

# The su command string itself must carry no interpolated repo name — that is
# the string that gets re-parsed, so nothing untrusted may reach it.
su_rec="$(read_nul "$SU_RECORD")"
su_cmd="$(grep -m1 '^SU_COMMAND=' <<<"$su_rec" | sed 's/^SU_COMMAND=//')"
untrusted_in_cmd=0
for name in "${REPO_NAMES[@]}"; do
  case "$su_cmd" in *"$name"*) untrusted_in_cmd=1;; esac
done
check "the su -c command string contains no interpolated directory name" \
  "$untrusted_in_cmd"
check "su ran as the dev user" \
  "$(grep -Fqx -- 'SU_USER=dev' <<<"$su_rec" && echo 0 || echo 1)" \
  "recorded: $(printf '%s' "$su_rec" | tr '\n' '|')"

# =========================================================================
# 3. The `--` before the user name is load-bearing — pin the su model
#    against the REAL su binary (argument parsing happens before auth, so
#    this needs no privileges).
# =========================================================================
if command -v /bin/su >/dev/null 2>&1 || command -v su >/dev/null 2>&1; then
  real_su="$(PATH="/usr/bin:/bin" command -v su)"
  if [ -n "$real_su" ]; then
    permuted="$("$real_su" -c 'echo x' nosuchuser_sb2418 --help 2>&1)"
    guarded="$("$real_su" -c 'echo x' -- nosuchuser_sb2418 --help 2>&1)"
    check "real su DOES permute post-user options (so the -- is required)" \
      "$(grep -qi 'usage' <<<"$permuted" && echo 0 || echo 1)" \
      "output: $(head -c 120 <<<"$permuted")"
    check "real su with -- before the user stops option parsing" \
      "$(grep -qi 'usage' <<<"$guarded" && echo 1 || echo 0)" \
      "output: $(head -c 120 <<<"$guarded")"
  fi
fi

# Structural guard: every su call in the entrypoint must use the `--` form,
# so a future edit cannot quietly reintroduce the permuting-getopt hole.
bad_su="$(grep -nE '^[[:space:]]*(if[[:space:]]+)?su[[:space:]]' "$ENTRYPOINT" \
          | grep -v -- '-- dev' || true)"
check "every raw su invocation in the entrypoint puts -- before the user" \
  "$([ -z "$bad_su" ] && echo 0 || echo 1)" "offending lines: $bad_su"

su_lines_with_repos="$(grep -nE '^[[:space:]]*(if[[:space:]]+)?su' "$ENTRYPOINT" \
                       | grep -F '${repos' || true)"
check "no repo array is interpolated into a su command string" \
  "$([ -z "$su_lines_with_repos" ] && echo 0 || echo 1)" \
  "offending lines: $su_lines_with_repos"

# =========================================================================
# 4. The LLDAP bind password never appears on a command line.
# =========================================================================
LLDAP_ADMIN_PASSWORD='sup3r-s3cret-bind-pw'
ldap_uri='ldap://localhost:3890'
admin_dn='uid=admin,ou=people,dc=example,dc=test'
group_dn='cn=devs,ou=groups,dc=example,dc=test'

members="$(ldap_group_members)"

ls_args="$(read_nul "$LS_ARGS_RECORD")"
check "ldapsearch argv carries no -w flag" \
  "$(grep -Fqx -- '-w' <<<"$ls_args" && echo 1 || echo 0)" \
  "argv: $(printf '%s' "$ls_args" | tr '\n' '|')"
check "the bind password appears nowhere in ldapsearch's argv (/proc/<pid>/cmdline)" \
  "$(grep -Fq -- "$LLDAP_ADMIN_PASSWORD" <<<"$ls_args" && echo 1 || echo 0)"
check "ldapsearch reads the password from a file (-y)" \
  "$(grep -Fqx -- '-y' <<<"$ls_args" && echo 0 || echo 1)"

pw_rec="$(read_nul "$LS_PWFILE_RECORD")"
check "the password file was mode 0600 at call time" \
  "$(grep -Fqx -- 'PWMODE=600' <<<"$pw_rec" && echo 0 || echo 1)" \
  "recorded: $(printf '%s' "$pw_rec" | tr '\n' '|')"
check "the password file held the password with NO trailing newline" \
  "$(grep -Fqx -- "PWCONTENT=$LLDAP_ADMIN_PASSWORD" <<<"$pw_rec" && echo 0 || echo 1)"

pwfile="$(grep -m1 '^PWFILE=' <<<"$pw_rec" | sed 's/^PWFILE=//')"
check "the password file is deleted once ldapsearch returns" \
  "$([ -n "$pwfile" ] && [ ! -e "$pwfile" ] && echo 0 || echo 1)" "file: $pwfile"

check "member uids are still parsed out of the LDIF" \
  "$([ "$members" = "$(printf 'alice\nbob')" ] && echo 0 || echo 1)" \
  "got: $(printf '%s' "$members" | tr '\n' '|')"

check "the entrypoint no longer passes the bind password with -w" \
  "$(grep -q -- '-w "\$LLDAP_ADMIN_PASSWORD"' "$ENTRYPOINT" && echo 1 || echo 0)"

# =========================================================================
# 5. safe.directory registration (#2612): git must WORK in a checkout the
#    entrypoint's non-recursive chown never reaches (a root-owned clone), the
#    registration must be idempotent, and it must not rewrite entries this
#    entrypoint does not own.
#
#    Real git, real config file. Ownership is forced with
#    GIT_TEST_ASSUME_DIFFERENT_OWNER=1, git's own switch for exercising the
#    "detected dubious ownership" path — so the case reproduces the reported
#    failure shape without needing root to chown a checkout.
# =========================================================================
GITCONFIG="$DEV_HOME_FAKE/.gitconfig"
gitg() { HOME="$DEV_HOME_FAKE" git config --global "$@"; }
safe_entries() { HOME="$DEV_HOME_FAKE" git config --global --get-all safe.directory 2>/dev/null; }
count_entries() { safe_entries | grep -Fxc -- "$1" || true; }

# A REAL repo, additionally to the fake `.git` files above, so the ownership
# check has something to run against.
OWNED_REPO='root-owned-repo'
git init -q "$DEV_HOME_FAKE/$OWNED_REPO" 2>/dev/null

# The state the reference box was found in: the same repo added over and over,
# an entry for a path that no longer exists, and entries OUTSIDE $DEV_HOME that
# belong to the operator, not to us.
rm -f "$GITCONFIG"
for _ in 1 2 3; do gitg --add safe.directory "$DEV_HOME_FAKE/normal-repo"; done
gitg --add safe.directory "$DEV_HOME_FAKE/solbay-gone"
gitg --add safe.directory '/tmp/dotfiles-edit'
gitg --add safe.directory '/tmp/dotfiles-edit'

check "reproducer: git refuses to run in a checkout it does not own" \
  "$(GIT_TEST_ASSUME_DIFFERENT_OWNER=1 HOME="$DEV_HOME_FAKE" \
       git -C "$DEV_HOME_FAKE/$OWNED_REPO" status --porcelain >/dev/null 2>&1 && echo 1 || echo 0)"

repos=()
discover_repos
check "discover_repos picks up the real checkout too" \
  "$(printf '%s\n' "${repos[@]}" | grep -Fqx -- "$OWNED_REPO" && echo 0 || echo 1)"

register_safe_directories "${repos[@]}"
reg_rc=$?
check "register_safe_directories exits 0" \
  "$([ "$reg_rc" -eq 0 ] && echo 0 || echo 1)" "exit=$reg_rc"

check "THE FIX: git now runs in the not-owned checkout" \
  "$(GIT_TEST_ASSUME_DIFFERENT_OWNER=1 HOME="$DEV_HOME_FAKE" \
       git -C "$DEV_HOME_FAKE/$OWNED_REPO" status --porcelain >/dev/null 2>&1 && echo 0 || echo 1)" \
  "entries: $(safe_entries | tr '\n' '|')"

for name in "${REPO_NAMES[@]}" "$OWNED_REPO"; do
  n="$(count_entries "$DEV_HOME_FAKE/$name")"
  check "exactly one safe.directory entry for [$name]" \
    "$([ "$n" -eq 1 ] && echo 0 || echo 1)" "count=$n"
done

check "the duplicate pile-up for one repo is collapsed to a single entry" \
  "$([ "$(count_entries "$DEV_HOME_FAKE/normal-repo")" -eq 1 ] && echo 0 || echo 1)" \
  "entries: $(safe_entries | tr '\n' '|')"

check "the dead entry under \$DEV_HOME is dropped" \
  "$([ "$(count_entries "$DEV_HOME_FAKE/solbay-gone")" -eq 0 ] && echo 0 || echo 1)"

# The scope guard: everything outside $DEV_HOME is the operator's, duplicates
# included. De-duplicating the whole config is NOT this entrypoint's business.
check "entries outside \$DEV_HOME are left exactly as they were" \
  "$([ "$(count_entries '/tmp/dotfiles-edit')" -eq 2 ] && echo 0 || echo 1)" \
  "count=$(count_entries '/tmp/dotfiles-edit')"

# Idempotency — the actual bug. Re-running must not grow the list by one entry
# per repo per boot.
before_total="$(safe_entries | grep -c '' || true)"
register_safe_directories "${repos[@]}"
register_safe_directories "${repos[@]}"
after_total="$(safe_entries | grep -c '' || true)"
check "re-running the registration twice more does not grow safe.directory" \
  "$([ "$before_total" = "$after_total" ] && echo 0 || echo 1)" \
  "before=$before_total after=$after_total"

# A checkout that appears AFTER boot still gets an entry + a session, because
# the reconcile pass re-discovers.
mkdir -p "$DEV_HOME_FAKE/late-clone"
: > "$DEV_HOME_FAKE/late-clone/.git"
: > "$SC_ARGS_RECORD"
reconcile_repos
check "a checkout created after boot gets a safe.directory entry" \
  "$([ "$(count_entries "$DEV_HOME_FAKE/late-clone")" -eq 1 ] && echo 0 || echo 1)"
check "a checkout created after boot is handed to start-claude" \
  "$(read_nul "$SC_ARGS_RECORD" | grep -Fqx -- 'late-clone' && echo 0 || echo 1)" \
  "argv: $(read_nul "$SC_ARGS_RECORD" | tr '\n' '|')"

# The #2418 guarantee must hold for the new code path too: hostile directory
# names reach `git config` as literal argv, never as shell source.
leaked="$(find "$WORK" -name 'pwned-*' 2>/dev/null | tr '\n' ' ')"
check "safe.directory registration evaluates no directory name as shell" \
  "$([ -z "$leaked" ] && echo 0 || echo 1)" "marker files created: $leaked"

# Structural guard: `--add` is what made the list grow unbounded.
check "the entrypoint never registers safe.directory with --add" \
  "$(grep -q -- '--add safe.directory' "$ENTRYPOINT" && echo 1 || echo 0)"
check "the entrypoint pins the value-pattern with --fixed-value" \
  "$(grep -q -- '--fixed-value' "$ENTRYPOINT" && echo 0 || echo 1)"

# =========================================================================
# 6. start-claude reports "everything already running" as SUCCESS, so the
#    entrypoint's periodic reconcile doesn't log a warning on every quiet
#    pass (#2612).
# =========================================================================
START_CLAUDE="$REPO_ROOT/templates/claude-dev/start-claude.sh"
TMUX_BIN="$WORK/tmux-bin"
mkdir -p "$TMUX_BIN"
cat > "$TMUX_BIN/tmux" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  has-session)  exit 0 ;;                       # the boot session exists
  list-windows) cat "$TMUX_WINDOWS" ;;
  new-window|new-session) printf '%s\0' "$@" >> "$TMUX_RECORD" ;;
esac
exit 0
STUB
cat > "$TMUX_BIN/claude" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$TMUX_BIN/tmux" "$TMUX_BIN/claude"
export TMUX_WINDOWS="$RECORD/tmux-windows.txt"
export TMUX_RECORD="$RECORD/tmux-new.txt"
printf '%s\n' 'normal-repo' > "$TMUX_WINDOWS"

sc_out="$(cd "$DEV_HOME_FAKE" && PATH="$TMUX_BIN:$PATH" TMUX= CLAUDE_START_NO_ATTACH=1 \
            bash "$START_CLAUDE" --continue -- normal-repo 2>&1)"
sc_rc=$?
check "start-claude exits 0 when every requested repo already has a window" \
  "$([ "$sc_rc" -eq 0 ] && echo 0 || echo 1)" "exit=$sc_rc out=$sc_out"

sc_out="$(cd "$DEV_HOME_FAKE" && PATH="$TMUX_BIN:$PATH" TMUX= CLAUDE_START_NO_ATTACH=1 \
            bash "$START_CLAUDE" --continue -- no-such-directory 2>&1)"
sc_rc=$?
check "start-claude still fails when it started nothing and found nothing" \
  "$([ "$sc_rc" -ne 0 ] && echo 0 || echo 1)" "exit=$sc_rc out=$sc_out"

# =========================================================================
echo
echo "claude-dev entrypoint: $((CASES - FAILURES))/$CASES checks passed"
[ "$FAILURES" -eq 0 ] || exit 1
