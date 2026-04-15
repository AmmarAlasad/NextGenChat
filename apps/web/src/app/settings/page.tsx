/**
 * Provider Settings Route
 *
 * Hosts the authenticated global provider settings UI used to manage shared AI
 * provider credentials, OAuth connections, and fallback selection.
 */

import { Suspense } from 'react';

import { ProviderSettingsScreen } from '@/components/provider-settings-screen';

export default function SettingsPage() {
  return (
    <Suspense fallback={null}>
      <ProviderSettingsScreen />
    </Suspense>
  );
}
