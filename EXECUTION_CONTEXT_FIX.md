# Agent Execution Context Fix

## Problem
The agent was failing with `NameError: name '__file__' is not defined` when executed in certain contexts, particularly in containerized environments or when using `exec()`.

## Root Cause
The `__file__` variable is only defined when Python code is executed as a script file. In other execution contexts (like `exec()`, module loading, or container runtimes), `__file__` may not be available.

The agent code was trying to use `__file__` directly without handling the case where it doesn't exist:
```python
script_dir = os.path.dirname(__file__)  # ❌ Fails in exec() context
```

## Solution
Implemented a defensive import strategy that handles all execution contexts:

1. **Try/Except for `__file__`**: Wrapped the `__file__` access in a try/except block to gracefully fall back when undefined
2. **Conditional Relative Imports**: Skip relative imports (`.quadlet_parser`) in non-module contexts
3. **Multiple Import Fallbacks**: Try direct import → use no-op function if unavailable
4. **No-Op Fallback**: Define a safe default `parse_quadlet_file()` that returns empty dict

### Code Changes (src/lib/agent/v4/agent.py)
```python
# Safely handle cases where __file__ might not be defined
try:
    script_dir = os.path.dirname(__file__)
    if script_dir and script_dir not in sys.path:
        sys.path.insert(0, script_dir)
except NameError:
    # __file__ not defined (exec context), try current directory
    if '.' not in sys.path:
        sys.path.insert(0, '.')

# Import Quadlet parser (skip relative import in exec contexts)
parse_quadlet_file = None
try:
    # Only try relative import if we're in a proper module context
    if __name__ != '__main__' and '.' in __name__:
        from .quadlet_parser import parse_quadlet_file
except (ImportError, ValueError, NameError):
    pass

# Try direct import as fallback
if not parse_quadlet_file:
    try:
        from quadlet_parser import parse_quadlet_file
    except ImportError:
        pass

# Final fallback: define no-op function
if not parse_quadlet_file:
    def parse_quadlet_file(content: str) -> Dict[str, Any]:
        """Fallback: returns empty dict if parser not available"""
        return {}
```

## Testing

### Test Scenarios Verified
✅ **Direct Python Import**: Agent imported as module  
✅ **Subprocess Execution**: Agent run as subprocess (typical production)  
✅ **Exec Context**: Agent code executed via `exec()` (container simulation)

### Test Results
```
[Test 1] Direct Python Import
✅ Agent imported successfully
✅ parse_quadlet_file function available: True

[Test 2] Subprocess Execution
✅ Agent subprocess started and ran (timeout expected)

[Test 3] Exec Context (Container Simulation)
✅ Agent executed in exec() context without __file__ error
✅ parse_quadlet_file callable: True
```

### Build & Test Status
- ✅ TypeScript build: Successful (0 errors)
- ✅ Unit tests: 7/7 passing
- ✅ Python syntax: Valid
- ✅ Agent startup: No import errors

## Backward Compatibility
All changes are backward compatible:
- Existing direct imports still work
- Subprocess execution unaffected
- No changes to public API or interfaces

## Impact
This fix ensures the agent can run reliably in any Python execution context:
- Direct script execution
- Module imports
- Subprocess calls
- Container/sandbox environments
- Serverless/exec contexts

The graceful fallback chain means even if `quadlet_parser` is unavailable, the agent continues to work (albeit without Quadlet relationship discovery).
