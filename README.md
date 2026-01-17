# METAR Station data API

This software is part of a suite for running a weather station for an airfield/airstrip.

This is a Cloudflare Workers implementation of a data API for uploading and serving weather data.

* Weather data is stored in a D1 database
* Webcam images are stored in a R2 bucket

Everything is designed to be optimized for low data use and to be compatible with Cloudflare free tier.
