function doGet(e) {
    return HtmlService.createTemplateFromFile('Index').evaluate().setTitle('BumpChecker');
}

function include(filename) {
    return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function getSheetNames(sheetId) {
    try {
        var ss = SpreadsheetApp.openById(sheetId);
        var sheets = ss.getSheets();
        return sheets.map(function (s) { return s.getName(); });
    } catch (err) {
        throw new Error('Unable to open spreadsheet: ' + err.message);
    }
}

function getSheetHeaders(sheetId, sheetName) {
    try {
        var ss = SpreadsheetApp.openById(sheetId);
        var sheet = ss.getSheetByName(sheetName);
        if (!sheet) throw new Error('Sheet not found: ' + sheetName);
        var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
        return headers;
    } catch (err) {
        throw new Error('Unable to read headers: ' + err.message);
    }
}

function processFiles(form) {
    // form contains: sheetId, sheetName, nameCol, secondaryCol, identifierCol,
    // reactMin/reactMax, commentMin/commentMax, tagMin/tagMax,
    // reactCsv (text), commentCsv (text)
    try {
        var ss = SpreadsheetApp.openById(form.sheetId);
        var sheet = ss.getSheetByName(form.sheetName);
        if (!sheet) throw new Error('Sheet not found: ' + form.sheetName);

        var data = sheet.getDataRange().getValues();
        if (data.length < 2) return { results: [], message: 'No data rows found' };

        var headers = data[0];
        var headerIndex = {};
        for (var i = 0; i < headers.length; i++) headerIndex[headers[i]] = i;

        function colIndexByName(name) {
            if (headerIndex.hasOwnProperty(name)) return headerIndex[name];
            // allow number index (1-based) passed
            var n = parseInt(name, 10);
            if (!isNaN(n)) return n - 1;
            throw new Error('Column not found: ' + name);
        }

        var nameIdx = colIndexByName(form.nameCol);
        var secIdx = colIndexByName(form.secondaryCol);
        var idIdx = colIndexByName(form.identifierCol);

        // Build member list from sheet rows
        var members = [];
        for (var r = 1; r < data.length; r++) {
            var row = data[r];
            var rawName = row[nameIdx] ? String(row[nameIdx]) : '';
            if (!rawName || String(rawName).trim() === '') {
                // skip rows with empty name column
                continue;
            }
            var member = {
                rowIndex: r + 1,
                name: rawName,
                secondary: row[secIdx] ? String(row[secIdx]) : '',
                identifier: row[idIdx] ? String(row[idIdx]) : ''
            };
            members.push(member);
        }

        // Parse CSV texts
        var reactMap = buildReactMap(form.reactCsv);
        var commentMap = buildCommentMap(form.commentCsv);

        // Criteria: reactRequired (boolean) and comment/tag ranges
        var reactRequired = (form.reactRequired === true || form.reactRequired === 'true');
        var commentMin = parseInt(form.commentMin || 0, 10) || 0;
        var commentMax = parseInt(form.commentMax || 0, 10) || Infinity;
        var tagMin = parseInt(form.tagMin || 0, 10) || 0;
        var tagMax = parseInt(form.tagMax || 0, 10) || Infinity;

        // Evaluate each member
        var results = [];
        members.forEach(function (m) {
            var norm = normalizeFB(m.identifier);
            var reacts = reactMap[norm] || 0;
            var comments = (commentMap[norm] && commentMap[norm].comments) || 0;
            var tags = (commentMap[norm] && commentMap[norm].tags) || 0;

            var status = { name: m.name, secondary: m.secondary, identifier: m.identifier, reacts: reacts, comments: comments, tags: tags, flags: [] };

            // Reacts: if required, mark No react or React; otherwise ignore reacts
            if (reactRequired) {
                if (reacts === 0) {
                    status.flags.push('No react');
                } else {
                    status.flags.push('Reacted');
                }
            }

            // Comments: mark faults or OK
            if (comments === 0) {
                status.flags.push('No comment');
            } else if (comments < commentMin) {
                status.flags.push('Not enough comments');
            } else if (comments > commentMax && isFinite(commentMax)) {
                status.flags.push('Too many comments');
            } else {
                status.flags.push('Comment OK');
            }

            // Tags: mark faults or OK
            if (tags === 0) {
                status.flags.push('No tags');
            } else if (tags < tagMin) {
                status.flags.push('Not enough tags');
            } else if (tags > tagMax && isFinite(tagMax)) {
                status.flags.push('Too many tags');
            } else {
                status.flags.push('Tag OK');
            }

            results.push(status);
        });

        return { results: results, message: 'OK' };

    } catch (err) {
        throw new Error('Processing error: ' + err.message);
    }
}

function buildReactMap(csvText) {
    var map = {};
    if (!csvText) return map;
    var rows = splitCsvLines(csvText);
    // Assume header has Name,Link or Link in second column
    var header = rows[0] || [];
    var linkIdx = header.indexOf('Link');
    if (linkIdx < 0) linkIdx = 1; // default to second column
    for (var i = 1; i < rows.length; i++) {
        var row = rows[i];
        if (!row || row.length <= linkIdx) continue;
        var link = normalizeFB(String(row[linkIdx] || ''));
        if (!link) continue;
        map[link] = (map[link] || 0) + 1;
    }
    return map;
}

function buildCommentMap(csvText) {
    var map = {};
    if (!csvText) return map;
    var rows = splitCsvLines(csvText);
    var header = rows[0] || [];
    var linkIdx = header.indexOf('Link');
    var commentsIdx = header.indexOf('Comments Count');
    var tagsIdx = header.indexOf('Tags Count');
    if (linkIdx < 0) linkIdx = 1;
    if (commentsIdx < 0) commentsIdx = 2;
    if (tagsIdx < 0) tagsIdx = 3;
    for (var i = 1; i < rows.length; i++) {
        var row = rows[i];
        if (!row || row.length <= linkIdx) continue;
        var link = normalizeFB(String(row[linkIdx] || ''));
        if (!link) continue;
        var comments = parseInt(row[commentsIdx] || 0, 10) || 0;
        var tags = parseInt(row[tagsIdx] || 0, 10) || 0;
        map[link] = { comments: comments, tags: tags };
    }
    return map;
}

function splitCsvLines(text) {
    // Normalize newlines and split into arrays using Utilities.parseCsv per line
    var lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    var rows = [];
    for (var i = 0; i < lines.length; i++) {
        if (lines[i].trim() === '') continue;
        try {
            var parsed = Utilities.parseCsv(lines[i]);
            if (parsed && parsed.length) rows.push(parsed[0]);
        } catch (e) {
            // fallback split by comma
            rows.push(lines[i].split(','));
        }
    }
    return rows;
}

function normalizeFB(url) {
    if (!url) return '';
    url = String(url).trim();
    // remove surrounding quotes
    if (url.charAt(0) === '"' && url.charAt(url.length - 1) === '"') url = url.slice(1, -1);
    // lowercase host but keep profile ids/case in path
    try {
        if (url.indexOf('http') !== 0) {
            // Maybe it's just an id or username - return trimmed
            return url.replace(/\s+/g, '').replace(/\/$/, '');
        }
        // remove protocol and www
        var u = url.replace(/https?:\/\/(www\.)?/i, '');
        // If this is a profile.php link with an id parameter, preserve only the id param
        var profileMatch = u.match(/facebook\.com\/profile\.php([^#]*)/i);
        if (profileMatch) {
            var qs = profileMatch[1] || '';
            var idMatch = qs.match(/[?&]id=(\d+)/);
            if (idMatch) {
                return 'facebook.com/profile.php?id=' + idMatch[1];
            }
        }
        // otherwise strip query string and trailing slash
        u = u.replace(/\?[^#]*$/, '');
        u = u.replace(/\/$/, '');
        return u;
    } catch (e) {
        return url;
    }
}

