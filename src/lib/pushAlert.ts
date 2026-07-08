export function trackPushEvent(eventName: string, properties?: Record<string, string>) {
  if (typeof window !== 'undefined' && typeof (window as any).PushAlertCo?.push === 'function') {
    (window as any).PushAlertCo.push(['track', eventName, properties || {}]);
  }
}

export function setPushAlertSubscriber(userId: string, email: string) {
  if (typeof window !== 'undefined' && typeof (window as any).PushAlertCo?.push === 'function') {
    (window as any).PushAlertCo.push(['setAttribute', 'user_id', userId]);
    (window as any).PushAlertCo.push(['setAttribute', 'email', email]);
  }
}
