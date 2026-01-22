import {IttyRouter, json} from "itty-router";

export const withAuthenticatedUser = (request, env) => {
    if (!env.API_TOKEN) {
        // assume wrong configuration
        throw new StatusError(401, "Unauthorized");
    }

    const auth = request.headers.get("Authorization");
    if (!auth || auth !== `Bearer ${env.API_TOKEN}`) {
        throw new StatusError(401, "Unauthorized");
    }

    // request processing may proceed
};

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

export const withRequestHeaders = (request) => {
    request.requestHeaders = request.headers;
}

export const withRawContent = (request) => {
    request.content = request.body;
}

export const corsify = (response, request) => {
    const r = response.clone();
    const origin = request.headers.get('Origin');
    if (origin === request.env.CORS_ORIGIN) {
        r.headers.append('access-control-allow-origin', request.env.CORS_ORIGIN);
        r.headers.append('vary', 'origin');
    }
    return r;
}
