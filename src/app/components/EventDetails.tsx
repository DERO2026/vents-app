import { useState } from 'react';
import { ArrowLeft, Heart, Share2, MapPin, Calendar, Clock, Users, Star, ChevronRight } from 'lucide-react';
import { Event, TicketType } from './types';
import { formatPrice } from './data';

interface EventDetailsProps {
  event: Event;
  onBack: () => void;
  onGetTickets: (ticketType: TicketType) => void;
  isSaved: boolean;
  onToggleSave: () => void;
}

export function EventDetails({ event, onBack, onGetTickets, isSaved, onToggleSave }: EventDetailsProps) {
  const [selectedTicket, setSelectedTicket] = useState<TicketType>(event.ticketTypes[0]);
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="flex flex-col h-full" style={{ background: '#020005' }}>
      {/* Hero Image */}
      <div className="relative" style={{ height: 'calc(280px + env(safe-area-inset-top))', flexShrink: 0 }}>
        <img src={event.image} alt={event.title} className="w-full h-full object-cover" />
        <div
          className="absolute inset-0"
          style={{ background: 'linear-gradient(to bottom, rgba(6,10,18,0.3) 0%, rgba(6,10,18,0.0) 40%, rgba(6,10,18,1) 100%)' }}
        />
        {/* Top bar */}
        <div 
          className="absolute top-0 left-0 right-0 flex items-center justify-between px-4"
          style={{ paddingTop: 'calc(12px + env(safe-area-inset-top))' }}
        >
          <button
            onClick={onBack}
            className="w-9 h-9 rounded-full flex items-center justify-center"
            style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(10px)' }}
          >
            <ArrowLeft size={18} color="#fff" />
          </button>
          <div className="flex gap-2">
            <button
              className="w-9 h-9 rounded-full flex items-center justify-center"
              style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(10px)' }}
            >
              <Share2 size={16} color="#fff" />
            </button>
            <button
              onClick={onToggleSave}
              className="w-9 h-9 rounded-full flex items-center justify-center"
              style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(10px)' }}
            >
              <Heart size={16} color={isSaved ? '#A78BFA' : '#fff'} fill={isSaved ? '#A78BFA' : 'none'} />
            </button>
          </div>
        </div>

        {/* Category badge */}
        <div className="absolute bottom-4 left-4">
          <span
            style={{
              fontSize: '11px',
              color: '#fff',
              fontWeight: 600,
              background: 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)',
              padding: '4px 10px',
              borderRadius: '8px',
              letterSpacing: '0.03em',
            }}
          >
            {event.category}
          </span>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto pb-28" style={{ scrollbarWidth: 'none' }}>
        <div className="px-4 pt-4">
          {/* Title */}
          <h1
            style={{
              color: '#F0F0FF',
              fontSize: '22px',
              fontWeight: 800,
              lineHeight: 1.2,
              fontFamily: 'Space Grotesk, sans-serif',
              letterSpacing: '-0.3px',
            }}
            className="mb-3"
          >
            {event.title}
          </h1>

          {/* Stats row */}
          <div className="flex items-center gap-4 mb-4">
            <div className="flex items-center gap-1.5">
              <div
                className="w-6 h-6 rounded flex items-center justify-center"
                style={{ background: 'rgba(167,139,250,0.15)' }}
              >
                <Star size={12} color="#A78BFA" fill="#A78BFA" />
              </div>
              <span style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 600 }}>4.8</span>
              <span style={{ color: '#8B8FA8', fontSize: '13px' }}>(284)</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div
                className="w-6 h-6 rounded flex items-center justify-center"
                style={{ background: 'rgba(167,139,250,0.15)' }}
              >
                <Users size={12} color="#A78BFA" />
              </div>
              <span style={{ color: '#8B8FA8', fontSize: '13px' }}>
                {event.attendees.toLocaleString()} attending
              </span>
            </div>
          </div>

          {/* Info cards */}
          <div className="flex flex-col gap-3 mb-4">
            <div
              className="flex items-center gap-3 p-3"
              style={{ background: '#090514', borderRadius: '14px', border: '1px solid rgba(255,255,255,0.05)' }}
            >
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{ background: 'rgba(167,139,250,0.15)' }}
              >
                <Calendar size={18} color="#A78BFA" />
              </div>
              <div>
                <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 500 }}>Date</p>
                <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600 }}>{event.date}</p>
              </div>
            </div>

            <div
              className="flex items-center gap-3 p-3"
              style={{ background: '#090514', borderRadius: '14px', border: '1px solid rgba(255,255,255,0.05)' }}
            >
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{ background: 'rgba(167,139,250,0.15)' }}
              >
                <Clock size={18} color="#A78BFA" />
              </div>
              <div>
                <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 500 }}>Time</p>
                <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600 }}>
                  {event.time} – {event.endTime}
                </p>
              </div>
            </div>

            <div
              className="flex items-center gap-3 p-3"
              style={{ background: '#090514', borderRadius: '14px', border: '1px solid rgba(255,255,255,0.05)' }}
            >
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{ background: 'rgba(167,139,250,0.15)' }}
              >
                <MapPin size={18} color="#A78BFA" />
              </div>
              <div className="flex-1">
                <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 500 }}>Location</p>
                <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600 }}>{event.venue}</p>
                <p style={{ color: '#8B8FA8', fontSize: '12px' }}>
                  {event.area}, {event.city}, {event.state}
                </p>
              </div>
              <button style={{ color: '#A78BFA', fontSize: '12px', fontWeight: 500 }}>Map</button>
            </div>
          </div>

          {/* About */}
          <div className="mb-5">
            <h3 style={{ color: '#F0F0FF', fontSize: '16px', fontWeight: 700 }} className="mb-2">
              About This Event
            </h3>
            <p
              style={{
                color: '#A8AEC8',
                fontSize: '14px',
                lineHeight: 1.6,
                display: '-webkit-box',
                WebkitLineClamp: expanded ? undefined : 3,
                WebkitBoxOrient: 'vertical',
                overflow: expanded ? 'visible' : 'hidden',
              }}
            >
              {event.description}
            </p>
            <button onClick={() => setExpanded(!expanded)} style={{ color: '#A78BFA', fontSize: '13px', fontWeight: 500 }} className="mt-1">
              {expanded ? 'Show less' : 'Read more'}
            </button>
          </div>

          {/* Tags */}
          {event.tags && (
            <div className="flex flex-wrap gap-2 mb-5">
              {event.tags.map((tag) => (
                <span
                  key={tag}
                  style={{
                    fontSize: '12px',
                    color: '#A78BFA',
                    background: 'rgba(167,139,250,0.1)',
                    padding: '4px 10px',
                    borderRadius: '8px',
                    border: '1px solid rgba(167,139,250,0.2)',
                    fontWeight: 500,
                  }}
                >
                  {tag}
                </span>
              ))}
            </div>
          )}

          {/* Organizer */}
          <div
            className="flex items-center gap-3 p-3 mb-5"
            style={{ background: '#090514', borderRadius: '14px', border: '1px solid rgba(255,255,255,0.05)' }}
          >
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
              style={{ background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)' }}
            >
              <span style={{ color: '#fff', fontSize: '16px', fontWeight: 700 }}>
                {event.organizer[0]}
              </span>
            </div>
            <div className="flex-1">
              <p style={{ color: '#8B8FA8', fontSize: '11px' }}>Organized by</p>
              <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600 }}>{event.organizer}</p>
            </div>
            <button
              className="flex items-center gap-1 px-3 py-1.5"
              style={{
                background: 'rgba(167,139,250,0.1)',
                borderRadius: '8px',
                border: '1px solid rgba(167,139,250,0.2)',
              }}
            >
              <span style={{ color: '#A78BFA', fontSize: '12px', fontWeight: 500 }}>Subscribe</span>
            </button>
          </div>

          {/* Ticket Selection */}
          <div className="mb-3">
            <h3 style={{ color: '#F0F0FF', fontSize: '16px', fontWeight: 700 }} className="mb-3">
              Select Ticket
            </h3>
            <div className="flex flex-col gap-2">
              {event.ticketTypes.map((ticket) => {
                const isSelected = selectedTicket.id === ticket.id;
                return (
                  <button
                    key={ticket.id}
                    onClick={() => setSelectedTicket(ticket)}
                    className="flex items-center justify-between p-3 text-left"
                    style={{
                      background: isSelected ? 'rgba(123,47,190,0.15)' : '#131629',
                      borderRadius: '14px',
                      border: isSelected ? '1.5px solid #7B2FBE' : '1px solid rgba(255,255,255,0.05)',
                      transition: 'all 0.2s ease',
                    }}
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0"
                        style={{
                          border: isSelected ? '5px solid #7B2FBE' : '2px solid #8B8FA8',
                          background: isSelected ? '#7B2FBE' : 'transparent',
                          transition: 'all 0.2s',
                        }}
                      />
                      <div>
                        <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600 }}>{ticket.name}</p>
                        <p style={{ color: '#8B8FA8', fontSize: '12px' }}>{ticket.description}</p>
                      </div>
                    </div>
                    <span style={{ color: '#FFB830', fontSize: '15px', fontWeight: 700 }}>
                      {formatPrice(ticket.price)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Bottom CTA */}
      <div
        className="absolute bottom-0 left-0 right-0 px-4 pb-6 pt-3"
        style={{
          background: 'linear-gradient(to top, #020005 80%, transparent)',
        }}
      >
        <button
          onClick={() => onGetTickets(selectedTicket)}
          className="w-full flex items-center justify-center gap-2"
          style={{
            height: '54px',
            background: 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)',
            borderRadius: '16px',
            boxShadow: '0 6px 24px rgba(123,47,190,0.45)',
          }}
        >
          <span style={{ color: '#fff', fontSize: '16px', fontWeight: 700 }}>
            Get Tickets · {formatPrice(selectedTicket.price)}
          </span>
        </button>
      </div>
    </div>
  );
}
