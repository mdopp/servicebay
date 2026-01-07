# Toast Notifications for Data Fetching

ServiceBay uses `useToast` for feedback during data operations.

## Pattern
1. Import `useToast` from '@/providers/ToastProvider'.
2. Use `addToast('loading', ...)` (duration 0) to start.
3. Use `updateToast(id, 'success'|'error', ...)` on completion.

## Example
```ts
const { addToast, updateToast } = useToast();
const fetcher = useCallback(async () => {
    const id = addToast('loading', 'Refreshing...', '', 0);
    try {
        const data = await api();
        updateToast(id, 'success', 'Done', 'Loaded');
        return data;
    } catch (e) {
        updateToast(id, 'error', 'Failed', String(e));
        throw e;
    }
}, []);
```

## Locations
- `src/hooks/useSharedData.ts`
- `src/components/VolumeList.tsx`
- `src/plugins/SystemInfoPlugin.tsx`
