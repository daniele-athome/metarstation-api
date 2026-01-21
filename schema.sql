CREATE TABLE measurements
(
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    payload   TEXT NOT NULL
);

CREATE UNIQUE INDEX measurements_timestamp_uindex
    ON measurements (timestamp);
