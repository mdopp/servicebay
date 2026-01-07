'use client';

import React, { createContext, useContext, useState, useCallback, ReactNode, useEffect, useRef } from 'react';

interface CacheEntry<T = unknown> {
    data: T;
    timestamp: number;
}

interface CacheContextType {
    cache: Record<string, CacheEntry>;
    setCache: <T>(key: string, data: T) => void;
    getCache: <T>(key: string) => T | null;
    invalidateCache: (key: string) => void;
}

const CacheContext = createContext<CacheContextType | undefined>(undefined);

/**
 * CacheProvider
 * 
 * A simple global cache context to share data between components and plugins.
 * Supports Stale-While-Revalidate pattern via the useCache hook.
 */
export function CacheProvider({ children }: { children: ReactNode }) {
    const [cache, setCacheState] = useState<Record<string, CacheEntry>>({});
    const cacheRef = useRef(cache);

    useEffect(() => {
        cacheRef.current = cache;
    }, [cache]);

    const setCache = useCallback(<T,>(key: string, data: T) => {
        setCacheState(prev => ({
            ...prev,
            [key]: { data, timestamp: Date.now() }
        }));
    }, []);

    // Stable getCache that reads from ref
    const getCache = useCallback(<T,>(key: string): T | null => {
        return cacheRef.current[key]?.data as T || null;
    }, []);

    const invalidateCache = useCallback((key: string) => {
         setCacheState(prev => {
             const newCache = { ...prev };
             delete newCache[key];
             return newCache;
         });
    }, []);

    return (
        <CacheContext.Provider value={{ cache, setCache, getCache, invalidateCache }}>
            {children}
        </CacheContext.Provider>
    );
}

/**
 * useCache Hook
 * 
 * Fetches data asynchronously while returning cached data immediately if available.
 * 
 * @param key Unique key for the cache entry (e.g., 'services-list', 'node-1-stats')
 * @param fetcher Async function that returns the data
 * @param deps Dependencies array for the fetcher (triggers re-fetch if changed)
 * @param options Configuration options
 * @returns Object containing data, loading/validating states, error, and refresh function
 */
export function useCache<T>(key: string, fetcher: () => Promise<T>, deps: unknown[] = [], options: { revalidateOnMount?: boolean } = {}) {
    const { revalidateOnMount = true } = options;
    const context = useContext(CacheContext);
    if (!context) throw new Error('useCache must be used within CacheProvider');

    const { getCache, setCache } = context;
    
    // Initialize from cache if available
    const [data, setData] = useState<T | null>(() => getCache<T>(key));
    const [loading, setLoading] = useState(!getCache<T>(key));
    const [validating, setValidating] = useState(false);
    const [error, setError] = useState<Error | null>(null);

    // Keep fetcher stable to avoid effect loops if user didn't memoize it, 
    // BUT we need to execute the LATEST fetcher if props changed.
    // The 'deps' array solves this similar to useEffect.
    const fetcherRef = useRef(fetcher);
    useEffect(() => {
        fetcherRef.current = fetcher;
    });

    const refresh = useCallback(async (showLoading = false) => {
        if (showLoading) setLoading(true);
        setValidating(true);
        try {
            const newData = await fetcherRef.current();
            setCache(key, newData);
            setData(newData);
            setError(null);
        } catch (e: unknown) {
            setError(e instanceof Error ? e : new Error(String(e)));
            console.error(`Failed to refresh cache for ${key}:`, e);
        } finally {
            setLoading(false);
            setValidating(false);
        }
    }, [key, setCache]); // fetcherRef is stable

    useEffect(() => {
        const hasData = !!getCache<T>(key);
        if (!hasData || revalidateOnMount) {
            refresh(false);
        }
        // fetcherRef and getCache are stable. key and revalidateOnMount are primitives/stable.
        // deps handles user dependencies.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [refresh, key, revalidateOnMount, ...deps]);

    return { data, loading, validating, error, refresh, setData };
}
