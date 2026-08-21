// Pin a non-UTC timezone so parseDate's assumed-UTC handling of offset-less
// ISO-8601 timestamps can't accidentally pass by coincidentally running on a
// UTC-pinned CI box.
process.env['TZ'] = 'America/New_York';
