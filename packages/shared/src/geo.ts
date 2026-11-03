/** Great-circle distance in metres. */
export function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

export function withinGeofence(
  point: { lat: number; lng: number },
  anchor: { lat: number; lng: number },
  radiusM: number,
): { inside: boolean; distanceM: number } {
  const d = distanceM(point.lat, point.lng, anchor.lat, anchor.lng);
  return { inside: d <= radiusM, distanceM: d };
}
