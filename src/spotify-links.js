// KRATOS Spotify v2.1: no credentials stored here; public Spotify links only.
// Spotify content is metadata, streamed only if Discord Player can bridge it.
export function parseSpotifyLink(raw) {
  let u;
  try { u = new URL(String(raw ?? '').trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'open.spotify.com' ||
      u.port || u.username || u.password) return null;
  const segments = u.pathname.split('/').filter(Boolean);
  if (/^intl-[a-z]{2}(?:-[a-z]{2})?$/i.test(segments[0] ?? '')) segments.shift();
  if (segments.length !== 2) return null;
  const [kind, id] = segments;
  if (!['track', 'album', 'playlist'].includes(kind) || !/^[a-zA-Z0-9]{22}$/.test(id)) return null;
  return { kind, url: `https://open.spotify.com/${kind}/${id}` };
}

export function spotifyInput(raw) {
  try {
    const u = new URL(String(raw ?? '').trim());
    return ['open.spotify.com', 'spotify.link'].includes(u.hostname.toLowerCase());
  } catch { return false; }
}

export function spotifyPlayMessage(result, spotifyKind) {
  const tracks = result?.searchResult?.tracks ?? result?.playlist?.tracks ?? result?.track?.playlist?.tracks;
  const count = Array.isArray(tracks) ? tracks.length : null;
  if (spotifyKind === 'playlist' || spotifyKind === 'album') {
    const label = spotifyKind === 'album' ? 'Spotify albümü' : 'Spotify listesi';
    return count ? `✅ **${label}** sıraya eklendi: **${count} şarkı**. Şarkılar çalınabilir kaynaklarla eşleştirilecek.`
      : `✅ **${label}** sıraya eklendi. Şarkılar çalınabilir kaynaklarla eşleştirilecek.`;
  }
  return null;
}
