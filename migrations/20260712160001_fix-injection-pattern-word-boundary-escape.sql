-- Fix for a bug caught by live REST testing right after 20260712160000
-- shipped: Postgres's regex engine (ARE) does not treat \b as a word
-- boundary the way PCRE/Perl/JS do -- \y is the ARE word-boundary escape.
-- \b silently degraded to a literal "b", so '<script\b' only matched a
-- literal "<scriptb" and never matched real "<script>" payloads -- the
-- injection-pattern check was a silent no-op for every case that mattered.
CREATE OR REPLACE FUNCTION public.reject_injection_patterns(p_label text, p_text text)
 RETURNS void
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
BEGIN
  IF p_text IS NULL THEN RETURN; END IF;
  IF p_text ~* '<script\y|<iframe\y|javascript:|on\w+\s*=\s*["'']' THEN
    RAISE EXCEPTION '% contains disallowed content', p_label;
  END IF;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.reject_injection_patterns(text, text) TO anon, authenticated;
