import { useAuth } from '../lib/auth';

export interface Fix {
  lat: number;
  lng: number;
  accuracyM?: number;
  simulated: boolean;
}

/**
 * Current position. With "Demo GPS" on (default on desktop demos) the fix is the target's own
 * coordinates with a few metres of jitter; otherwise the device GPS, falling back to the target.
 */
export async function currentFix(target: { lat: number; lng: number }): Promise<Fix> {
  const jitter = () => (Math.random() - 0.5) * 0.0004;
  const simulated = (): Fix => ({ lat: target.lat + jitter(), lng: target.lng + jitter(), accuracyM: 15, simulated: true });
  if (useAuth.getState().simulateGps || !('geolocation' in navigator)) return simulated();
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: p.coords.accuracy, simulated: false }),
      () => resolve(simulated()),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30_000 },
    );
  });
}
