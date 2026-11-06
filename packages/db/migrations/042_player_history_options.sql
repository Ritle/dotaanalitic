-- Old reports and lineup keys retain the original 90-day / 10-map meaning.
ALTER TABLE player_history_runs ADD COLUMN options jsonb NOT NULL DEFAULT '{"windowDays":90,"maxMaps":10}'::jsonb;
ALTER TABLE player_history_runs ADD CONSTRAINT player_history_options_valid CHECK (
 jsonb_typeof(options)='object' AND options ?& ARRAY['windowDays','maxMaps'] AND
 (options-'windowDays'-'maxMaps')='{}'::jsonb AND
 options->'windowDays' IN ('90'::jsonb,'180'::jsonb,'365'::jsonb,'730'::jsonb) AND
 options->'maxMaps' IN ('10'::jsonb,'25'::jsonb,'50'::jsonb)
);
