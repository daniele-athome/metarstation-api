import {StatusError} from "itty-router/StatusError";

// parses JSON as request.content or returns a 400 error
export const withJsonContent = async (request) => {
    try {
        request.content = await request.json();
    } catch (err) {
        throw new StatusError(400, 'Invalid JSON payload.');
    }
};

export const withEnv = (request, env) => {
    request.env = env;
};

export const corsify = (allowedOrigin, response, request) => {
    const r = response.clone();
    const origin = request.headers.get('Origin');
    r.headers.append('access-control-allow-origin',
        allowedOrigin === '*' ? origin : allowedOrigin);
    return r;
}
