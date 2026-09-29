-- Migration number: 0001 	 2026-09-29T00:00:00.000Z
CREATE TABLE measurements
(
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    payload   TEXT NOT NULL
);

CREATE UNIQUE INDEX measurements_timestamp_uindex
    ON measurements (timestamp);
