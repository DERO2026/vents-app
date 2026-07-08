import { Bookmark, MapPin, Calendar, ArrowLeft } from 'lucide-react';
import { Event } from './types';
import { formatPrice } from './data';

interface SavedScreenProps {
  savedEventIds: string[];
  onEventPress: (event: Event) => void;
  onToggleSave: (id: string) => void;
  dbEvents: Event[];
  onBack?: () => void;
}

export function SavedScreen({ savedEventIds, onEventPress, onToggleSave, dbEvents, onBack }: SavedScreenProps) {
  const savedEvents = dbEvents.filter((e) => savedEventIds.includes(e.id));

  return (
    <div className="flex flex-col h-full" style={{ background: '#020005' }}>
      {/* Header */}
      <div className="px-4 pb-4" style={{ paddingTop: 'calc(20px + env(safe-area-inset-top))' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '2px' }}>
          {onBack && (
            <button
              onClick={onBack}
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center' }}
              aria-label="Go back"
            >
              <ArrowLeft size={22} color="#A78BFA" />
            </button>
          )}
          <h1 style={{ color: '#F0F0FF', fontSize: '20px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', margin: 0 }}>
            Saved Events
          </h1>
        </div>
        <p style={{ color: '#8B8FA8', fontSize: '13px' }}>{savedEvents.length} event{savedEvents.length !== 1 ? 's' : ''} saved</p>
      </div>

      <div className="flex-1 overflow-y-auto px-4" style={{ scrollbarWidth: 'none', paddingBottom: 'calc(96px + env(safe-area-inset-bottom))' }}>
        {savedEvents.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full pb-20">
            <div
              className="w-20 h-20 rounded-full flex items-center justify-center mb-4"
              style={{ background: '#090514' }}
            >
              <Bookmark size={36} color="#2A2D3E" strokeWidth={1.5} />
            </div>
            <p style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 700 }}>No saved events</p>
            <p style={{ color: '#8B8FA8', fontSize: '14px', marginTop: '4px', textAlign: 'center' }}>
              Tap the bookmark icon on any event to save it here
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {savedEvents.map((event) => (
              <div
                key={event.id}
                onClick={() => onEventPress(event)}
                className="flex gap-3 cursor-pointer active:opacity-90 p-3"
                style={{
                  background: '#090514',
                  borderRadius: '16px',
                  border: '1px solid rgba(255,255,255,0.05)',
                }}
              >
                <div className="relative flex-shrink-0">
                  <img
                    src={event.image}
                    alt={event.title}
                    className="object-cover"
                    style={{ width: '90px', height: '90px', borderRadius: '12px' }}
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between">
                    <span
                      style={{
                        fontSize: '10px',
                        color: '#A78BFA',
                        background: 'rgba(167,139,250,0.1)',
                        padding: '2px 6px',
                        borderRadius: '4px',
                        fontWeight: 600,
                      }}
                    >
                      {event.category}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleSave(event.id);
                      }}
                      className="ml-2"
                    >
                      <Bookmark size={16} color="#A78BFA" fill="#A78BFA" />
                    </button>
                  </div>
                  <h3
                    style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600, lineHeight: 1.3 }}
                    className="mt-1 mb-1 truncate"
                  >
                    {event.title}
                  </h3>
                  <div className="flex items-center gap-1 mb-0.5">
                    <Calendar size={10} color="#8B8FA8" />
                    <span style={{ color: '#8B8FA8', fontSize: '11px' }}>{event.date}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1">
                      <MapPin size={10} color="#8B8FA8" />
                      <span style={{ color: '#8B8FA8', fontSize: '11px' }}>{event.city}</span>
                    </div>
                    <span style={{ color: '#FFB830', fontSize: '13px', fontWeight: 700 }}>
                      {formatPrice(event.price)}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
