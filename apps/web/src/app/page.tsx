/**
 * Landing Route
 *
 * Phase 1 implementation status:
 * - This file now acts as the route gate into the first working local flow.
 * - Current scope redirects users into setup, login, or chat based on backend state.
 * - Future phases can turn this into a richer dashboard or workspace selector.
 */

import { HomeGate } from '@/components/home-gate';

export default function Home() {
  return <HomeGate />;
}
