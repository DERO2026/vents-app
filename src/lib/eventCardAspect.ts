// ─── The one true Event Card aspect ratio ────────────────────────────────────
// Every event flyer is cropped to THIS ratio, and every card placement renders
// its image box at THIS ratio, so what an organizer sees while cropping is
// exactly what attendees see after publishing — on the Home feed, Search,
// Category pages, Saved, Organizer profile, Featured, Trending, Related, and the
// Event Details header. Change it in one place and the whole app stays aligned.
//
// 4:5 (portrait) is the standard social-flyer ratio: tall enough for a poster,
// short enough to fit several cards on a mobile feed without excessive scroll.

export const EVENT_CARD_ASPECT = 4 / 5; // width / height = 0.8
export const EVENT_CARD_ASPECT_CSS = '4 / 5';
