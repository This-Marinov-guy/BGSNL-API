export const decodeJWT = (token) => {
    const [header, payload, signature] = token.split('.');

    const decodedPayload = atob(payload);

    const decodedPayloadJSON = JSON.parse(decodedPayload);

    return decodedPayloadJSON;
}

export const extractUserFromRequest = (req) => {
    const authHeader = req.headers['authorization']; 
    const token = authHeader && authHeader.split(' ')[1]; 
    if (!token) {
        return {}
    }

    return decodeJWT(token);
}

export const getTokenFromHeader = (req) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return null
    } 

    return token;
}