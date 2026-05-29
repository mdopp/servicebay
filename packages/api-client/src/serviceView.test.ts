import { describe, it, expect } from 'vitest';
import { sortServicesByDisplayName } from './serviceView';

describe('sortServicesByDisplayName', () => {
    it('orders by the user-facing displayName, not the systemd unit name', () => {
        // `nginx.service` renders as "Reverse Proxy (Nginx)" — it must sort
        // under R, not under its unit id n. (#1287)
        const services = [
            { name: 'nginx.service', displayName: 'Reverse Proxy (Nginx)' },
            { name: 'authelia.service', displayName: 'Authelia' },
            { name: 'vaultwarden.service', displayName: 'Vaultwarden' },
        ];
        const sorted = sortServicesByDisplayName(services).map(s => s.displayName);
        expect(sorted).toEqual(['Authelia', 'Reverse Proxy (Nginx)', 'Vaultwarden']);
    });

    it('does not mutate the input array', () => {
        const services = [
            { name: 'b.service', displayName: 'Bravo' },
            { name: 'a.service', displayName: 'Alpha' },
        ];
        const snapshot = [...services];
        sortServicesByDisplayName(services);
        expect(services).toEqual(snapshot);
    });

    it('sorts case-insensitively per locale rules', () => {
        const services = [
            { name: 'z.service', displayName: 'zebra' },
            { name: 'a.service', displayName: 'Apple' },
        ];
        const sorted = sortServicesByDisplayName(services).map(s => s.displayName);
        expect(sorted).toEqual(['Apple', 'zebra']);
    });

    it('handles an empty list', () => {
        expect(sortServicesByDisplayName([])).toEqual([]);
    });
});
