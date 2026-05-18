function relayosCountryFlag(countryCode) {
    const code = String(countryCode || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) {
        return '';
    }

    return String.fromCodePoint(
        127397 + code.charCodeAt(0),
        127397 + code.charCodeAt(1)
    );
}

function relayosBadgesFromMetadata(metadata) {
    const badges = [];
    const safeMetadata = metadata || {};
    const countryFlag = relayosCountryFlag(safeMetadata['geo/country-code']);

    if (countryFlag) {
        badges.push(countryFlag);
    }

    if (safeMetadata['entitlement/lucky']) {
        badges.push('🍀');
    }

    return badges;
}

if (typeof window !== 'undefined') {
    window.relayosCountryFlag = relayosCountryFlag;
    window.relayosBadgesFromMetadata = relayosBadgesFromMetadata;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        relayosCountryFlag,
        relayosBadgesFromMetadata,
    };
}
