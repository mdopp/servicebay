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

export function CacheProvider({ children }: { children: ReactNode }) {
    const [cache, setCacheState] = useState<Record<string, CacheEntry>>({});

    const setCache = useCallback(<T,>(key: string, data: T) => {
        setCacheState(prev => ({
            ...prev,
            [key]: { data, timestamp: Date.now() }
        }));
    }, []);

    const getCache = useCallback(<T,>(key: string): T | null => {
        return cache[key]?.data as T || null;
    }, [cache]);

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

export function useCache<T>(key: string, fetcher: () => Promise<T>, deps: unknown[] = []) {
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
        refresh(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [refresh, key, ...deps]);

    return { data, loading, validating, error, refresh, setData };
}
