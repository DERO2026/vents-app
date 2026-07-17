-- Verification queue analytics for the admin "Organizer Verification" tab —
-- Pending Review / Approved Today / Rejected Today / Average Review Time /
-- Total Verified, computed server-side (admin-gated) instead of trusting the
-- client with unrestricted access to organizer_verification_requests.

CREATE OR REPLACE FUNCTION public.admin_get_verification_stats()
RETURNS TABLE(
  pending_count bigint,
  approved_today bigint,
  rejected_today bigint,
  avg_review_hours numeric,
  total_verified bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  RETURN QUERY
  SELECT
    count(*) FILTER (WHERE r.status = 'pending')::bigint AS pending_count,
    count(*) FILTER (WHERE r.status = 'approved' AND r.reviewed_at >= date_trunc('day', now()))::bigint AS approved_today,
    count(*) FILTER (WHERE r.status = 'rejected' AND r.reviewed_at >= date_trunc('day', now()))::bigint AS rejected_today,
    round(avg(EXTRACT(EPOCH FROM (r.reviewed_at - r.created_at)) / 3600.0) FILTER (WHERE r.reviewed_at IS NOT NULL), 1) AS avg_review_hours,
    count(*) FILTER (WHERE r.status = 'approved')::bigint AS total_verified
  FROM public.organizer_verification_requests r;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_get_verification_stats() TO authenticated;
