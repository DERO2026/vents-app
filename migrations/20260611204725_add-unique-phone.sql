-- Alter users table to add unique constraint to phone_number
ALTER TABLE public.users ADD CONSTRAINT users_phone_number_key UNIQUE (phone_number);
