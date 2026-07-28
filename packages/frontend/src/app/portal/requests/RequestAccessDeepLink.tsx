'use client';

import { useRouter } from 'next/navigation';
import RequestAccessDialog from '../RequestAccessDialog';

/**
 * The `/portal/requests` deep link (#2405): renders the request-access
 * modal **already open**, so the Solaris companion app's "Request access"
 * button (mdopp/solaris-android#50) lands the visitor straight in the form
 * instead of on the portal root with one more click to make.
 *
 * Dismissing (backdrop, Cancel, or "Got it" after submitting) returns to
 * `/portal` — the deep-link route has nothing else to show, and the portal
 * root is where the state-aware CTA (#1001) picks the story up.
 */
export default function RequestAccessDeepLink() {
  const router = useRouter();
  return <RequestAccessDialog onClose={() => router.push('/portal')} />;
}
