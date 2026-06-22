import { redirect } from 'next/navigation';

/**
 * Root → Services (IA redesign slice 2, spec §2/§4.1: "the list of services is
 * the home"). The old Home hub (OverviewDashboard) is retired from the top nav;
 * its one piece of unique live content — the install-progress monitor — is
 * folded into the Services list (ServicesDashboard), so nothing is lost. Every
 * other Home card (Services / Network / Diagnostics / SSH Terminal / Settings)
 * was a pure navigation shortcut now covered by the collapsed top nav.
 */
export default function HomePage() {
  redirect('/services');
}
