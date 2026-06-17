import { initViewer, loadModel } from './viewer.js';

initViewer(document.getElementById('preview')).then(async viewer => {
    const urn = window.location.hash?.substring(1);
    setupModelSelection(viewer, urn);
    setupModelUpload(viewer);

    await viewer.loadExtension('Autodesk.Viewing.MarkupsCore');
    await viewer.loadExtension('Autodesk.DataVisualization');
    setupAnnotationUI(viewer);
});

// ─── Model selection / upload (unchanged) ─────────────────────────────────────

async function setupModelSelection(viewer, selectedUrn) {
    const dropdown = document.getElementById('models');
    dropdown.innerHTML = '';
    try {
        const resp = await fetch('/api/models');
        if (!resp.ok) throw new Error(await resp.text());
        const models = await resp.json();
        dropdown.innerHTML = models.map(m =>
            `<option value=${m.urn} ${m.urn === selectedUrn ? 'selected' : ''}>${m.name}</option>`
        ).join('\n');
        dropdown.onchange = () => onModelSelected(viewer, dropdown.value);
        if (dropdown.value) onModelSelected(viewer, dropdown.value);
    } catch (err) {
        alert('Could not list models. See the console for more details.');
        console.error(err);
    }
}

async function setupModelUpload(viewer) {
    const upload = document.getElementById('upload');
    const input = document.getElementById('input');
    const models = document.getElementById('models');
    upload.onclick = () => input.click();
    input.onchange = async () => {
        const file = input.files[0];
        const data = new FormData();
        data.append('model-file', file);
        if (file.name.endsWith('.zip')) {
            const ep = window.prompt('Please enter the filename of the main design inside the archive.');
            data.append('model-zip-entrypoint', ep);
        }
        upload.setAttribute('disabled', 'true');
        models.setAttribute('disabled', 'true');
        showNotification(`Uploading model <em>${file.name}</em>. Do not reload the page.`);
        try {
            const resp = await fetch('/api/models', { method: 'POST', body: data });
            if (!resp.ok) throw new Error(await resp.text());
            const model = await resp.json();
            setupModelSelection(viewer, model.urn);
        } catch (err) {
            alert(`Could not upload model ${file.name}. See the console for more details.`);
            console.error(err);
        } finally {
            clearNotification();
            upload.removeAttribute('disabled');
            models.removeAttribute('disabled');
            input.value = '';
        }
    };
}

async function onModelSelected(viewer, urn) {
    if (window.onModelSelectedTimeout) {
        clearTimeout(window.onModelSelectedTimeout);
        delete window.onModelSelectedTimeout;
    }
    window.location.hash = urn;
    try {
        const resp = await fetch(`/api/models/${urn}/status`);
        if (!resp.ok) throw new Error(await resp.text());
        const status = await resp.json();
        switch (status.status) {
            case 'n/a':
                showNotification('Model has not been translated.');
                break;
            case 'inprogress':
                showNotification(`Model is being translated (${status.progress})...`);
                window.onModelSelectedTimeout = setTimeout(onModelSelected, 5000, viewer, urn);
                break;
            case 'failed':
                showNotification(`Translation failed. <ul>${status.messages.map(m => `<li>${JSON.stringify(m)}</li>`).join('')}</ul>`);
                break;
            default:
                clearNotification();
                loadModel(viewer, urn);
                break;
        }
    } catch (err) {
        alert('Could not load model. See the console for more details.');
        console.error(err);
    }
}

function showNotification(message) {
    const overlay = document.getElementById('overlay');
    overlay.innerHTML = `<div class="notification">${message}</div>`;
    overlay.style.display = 'flex';
}
function clearNotification() {
    const overlay = document.getElementById('overlay');
    overlay.innerHTML = '';
    overlay.style.display = 'none';
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Open file picker, resolve with base64 Data URL. */
function pickImageAsBase64() {
    return new Promise((resolve, reject) => {
        const input = document.getElementById('image-input');
        input.value = '';
        input.onchange = () => {
            const file = input.files[0];
            if (!file) { reject(new Error('No file selected')); return; }
            const reader = new FileReader();
            reader.onload = e => resolve(e.target.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        };
        input.click();
    });
}

/** Resize an image Data URL into a square canvas Data URL (for sprite atlas). */
function buildSpriteAtlas(imageDataUrl, size = 64) {
    return new Promise((resolve, reject) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d');
        const img = new Image();
        img.onload = () => {
            const s = Math.min(size / img.width, size / img.height);
            const sw = img.width * s, sh = img.height * s;
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, size, size);
            ctx.drawImage(img, (size - sw) / 2, (size - sh) / 2, sw, sh);
            resolve(canvas.toDataURL('image/png'));
        };
        img.onerror = reject;
        img.src = imageDataUrl;
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 2D IMAGE PLACEMENT — 3-PHASE STATE MACHINE
// ─────────────────────────────────────────────────────────────────────────────
//
// Phase 1 PLACING  – crosshair overlay waits for a viewer click
// Phase 2 EDITING  – editing box with drag + 8 resize handles + W/H inputs
// Phase 3 CONFIRM  – convert screen rect → SVG coords, inject <image> element
//
// All interaction during Phase 2 is in plain SCREEN PIXELS relative to the
// viewer container. We convert to SVG model-space only once, at confirm time.
//
// ─────────────────────────────────────────────────────────────────────────────

// Current editing state (screen-pixel rect relative to viewer container)
let imgState = { x: 0, y: 0, w: 200, h: 150 };
let imgBase64 = null;   // the image being placed

const placementLayer = document.getElementById('img-placement-layer');
const editingBox = document.getElementById('img-editing-box');
const editPreview = document.getElementById('img-editing-preview');
const inputW = document.getElementById('img-input-w');
const inputH = document.getElementById('img-input-h');

/** Sync the editing-box position/size CSS from imgState. */
function applyEditState() {
    editingBox.style.left = imgState.x + 'px';
    editingBox.style.top = imgState.y + 'px';
    editingBox.style.width = imgState.w + 'px';
    editingBox.style.height = imgState.h + 'px';
    inputW.value = Math.round(imgState.w);
    inputH.value = Math.round(imgState.h);
}

/** Show the editing box at (anchorX, anchorY) in viewer-container pixels. */
function enterEditingPhase(anchorX, anchorY) {
    imgState = { x: anchorX - 100, y: anchorY - 75, w: 200, h: 150 };
    editPreview.src = imgBase64;
    editingBox.classList.add('active');
    applyEditState();
}

/** Hide both overlay and editing box, reset state. */
function exitImagePlacement() {
    placementLayer.classList.remove('active');
    editingBox.classList.remove('active');
    imgBase64 = null;
}

// ── Numeric input changes → snap editing box ─────────────────────────────────
inputW.addEventListener('change', () => {
    const v = Math.max(30, parseInt(inputW.value) || 30);
    imgState.w = v;
    applyEditState();
});
inputH.addEventListener('change', () => {
    const v = Math.max(30, parseInt(inputH.value) || 30);
    imgState.h = v;
    applyEditState();
});

// ── Body drag (move the whole box) ───────────────────────────────────────────
let bodyDragging = false, bdStartMouse = null, bdStartState = null;

editingBox.addEventListener('mousedown', e => {
    // Ignore clicks that originate from a handle or toolbar
    if (e.target.classList.contains('img-resize-handle')) return;
    if (e.target.closest('#img-mini-toolbar')) return;

    e.preventDefault();
    bodyDragging = true;
    bdStartMouse = { x: e.clientX, y: e.clientY };
    bdStartState = { ...imgState };
});

// ── Resize handle drag ────────────────────────────────────────────────────────
let handleDragging = false, hdDir = null, hdStartMouse = null, hdStartState = null;

document.querySelectorAll('.img-resize-handle').forEach(handle => {
    handle.addEventListener('mousedown', e => {
        e.preventDefault();
        e.stopPropagation();
        handleDragging = true;
        hdDir = handle.dataset.dir;
        hdStartMouse = { x: e.clientX, y: e.clientY };
        hdStartState = { ...imgState };
    });
});

// ── Shared mousemove / mouseup for both drag types ───────────────────────────
document.addEventListener('mousemove', e => {
    if (!bodyDragging && !handleDragging) return;

    const dx = e.clientX - (bodyDragging ? bdStartMouse : hdStartMouse).x;
    const dy = e.clientY - (bodyDragging ? bdStartMouse : hdStartMouse).y;
    const s = { ...hdStartState } || { ...bdStartState };

    if (bodyDragging) {
        imgState.x = bdStartState.x + dx;
        imgState.y = bdStartState.y + dy;
    } else {
        // Resize: update x/y/w/h per handle direction
        const MIN = 30;
        let { x, y, w, h } = hdStartState;

        if (hdDir.includes('e')) w = Math.max(MIN, w + dx);
        if (hdDir.includes('s')) h = Math.max(MIN, h + dy);
        if (hdDir.includes('w')) { const nw = Math.max(MIN, w - dx); x += w - nw; w = nw; }
        if (hdDir.includes('n')) { const nh = Math.max(MIN, h - dy); y += h - nh; h = nh; }

        imgState = { x, y, w, h };
    }

    applyEditState();
});

document.addEventListener('mouseup', () => {
    bodyDragging = handleDragging = false;
    bdStartMouse = hdStartMouse = null;
    bdStartState = hdStartState = null;
});

// ─────────────────────────────────────────────────────────────────────────────
// SVG COORDINATE CONVERSION + <image> INJECTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a screen-pixel rect (relative to viewerContainer) to SVG model-space.
 *
 * KEY TRICK: We call getScreenCTM() on a *child <g> element* inside the SVG,
 * NOT on the root <svg> itself. This means the CSS `scale(1,-1)` that
 * MarkupsCore applies to the <svg> tag is EXCLUDED from the matrix,
 * so we get pure viewBox-based coordinates without a Y-flip.
 */
function screenRectToSvgCoords(svgEl, pixelRect, viewerContainer) {
    const cRect = viewerContainer.getBoundingClientRect();

    // Screen coords of the four corners in client space
    const cl = cRect.left + pixelRect.x;
    const ct = cRect.top + pixelRect.y;
    const cr = cl + pixelRect.w;
    const cb = ct + pixelRect.h;

    // Use a child <g> to get a CTM without the CSS flip on the root <svg>
    const refEl = svgEl.querySelector('g') || svgEl;
    const ctm = refEl.getScreenCTM();
    if (!ctm) {
        console.error('[ImageMarkup] getScreenCTM() returned null');
        return null;
    }
    const inv = ctm.inverse();

    const toSvg = (cx, cy) => {
        const pt = svgEl.createSVGPoint();
        pt.x = cx; pt.y = cy;
        return pt.matrixTransform(inv);
    };

    const tl = toSvg(cl, ct);
    const br = toSvg(cr, cb);

    return {
        x: Math.min(tl.x, br.x),
        y: Math.min(tl.y, br.y),
        w: Math.abs(br.x - tl.x),
        h: Math.abs(br.y - tl.y)
    };
}

function commitImageToSvg(svgEl, svgRect, base64DataUrl) {
    // svgRect: { x, y, w, h } in SVG model-space

    const imgEl = document.createElementNS('http://www.w3.org/2000/svg', 'image');
    imgEl.setAttributeNS('http://www.w3.org/1999/xlink', 'href', base64DataUrl);
    imgEl.setAttribute('href', base64DataUrl);
    imgEl.setAttribute('x', svgRect.x);
    imgEl.setAttribute('y', svgRect.y);
    imgEl.setAttribute('width', svgRect.w);
    imgEl.setAttribute('height', svgRect.h);
    imgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    imgEl.setAttribute('data-markup-image', 'true');

    // Because the root <svg> has scale(1,-1), this image is visually in the right place 
    // but rendered upside-down. We apply a local flip around its own centerline to fix orientation.
    imgEl.setAttribute('transform',
        `scale(1,-1) translate(0, ${-(2 * svgRect.y + svgRect.h)})`
    );

    svgEl.appendChild(imgEl);
    return imgEl;
}

/**
 * Merge injected <image data-markup-image> nodes into the SVG string from
 * generateData(). Falls back to a minimal SVG shell if no tool markups exist.
 *
 * generateData() can throw when MarkupsCore has never been put in edit mode
 * (image-only path) or when the extension isn't shown at all (3D pin path).
 * We always wrap it in try/catch and fall back to the live SVG DOM instead.
 */
function mergeInjectedImages(markupsExt) {
    // ── Step 1: safely call generateData() ───────────────────────────────────
    let svgData = null;
    try {
        svgData = markupsExt.generateData();
    } catch (err) {
        console.warn('[mergeInjectedImages] generateData() threw (expected when no edit session):', err.message);
        svgData = null;
    }

    // ── Step 2: collect injected <image> nodes from the live SVG ─────────────
    const svgEl = markupsExt.svg;   // null if extension was never shown
    const injected = svgEl
        ? Array.from(svgEl.querySelectorAll('[data-markup-image]'))
        : [];

    // Nothing from either source → nothing to save
    if (!svgData && injected.length === 0) return null;

    // ── Step 3: if generateData gave us nothing, build SVG from live DOM ──────
    if (!svgData) {
        if (!svgEl) {
            // markupsExt was never shown — can't produce SVG at all
            console.error('[mergeInjectedImages] SVG element not available.');
            return null;
        }
        // Serialize the entire live SVG (it already contains the <image> nodes)
        svgData = new XMLSerializer().serializeToString(svgEl);
    }

    // If there are no injected images to merge, return what generateData gave us
    if (injected.length === 0) return svgData;

    // ── Step 4: merge injected <image> nodes into the serialized SVG string ───
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgData, 'image/svg+xml');
    const parseErr = doc.querySelector('parsererror');
    if (parseErr) {
        // Serialized SVG was malformed – fall back to raw live SVG
        console.warn('[mergeInjectedImages] SVG parse error, falling back to live DOM serialization.');
        return new XMLSerializer().serializeToString(svgEl);
    }

    injected.forEach(el => {
        const clone = el.cloneNode(true);
        const href = el.getAttribute('href')
            || el.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
        if (href) {
            clone.setAttribute('href', href);
            clone.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', href);
        }
        doc.documentElement.appendChild(clone);
    });

    return new XMLSerializer().serializeToString(doc);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3D – DataVisualization custom sprite atlas
// ─────────────────────────────────────────────────────────────────────────────

async function buildImageViewable(worldPoint, imageDataUrl, dbId) {
    const DVCore = Autodesk.DataVisualization.Core;
    const atlas = await buildSpriteAtlas(imageDataUrl, 64);

    const style = new DVCore.ViewableStyle(
        DVCore.ViewableType.SPRITE,
        new THREE.Color(1, 1, 1),
        atlas,
        0,
        { width: 1, height: 1 }
    );

    const vd = new DVCore.ViewableData();
    vd.spriteSize = 48;

    const pos = new THREE.Vector3(worldPoint.x, worldPoint.y, worldPoint.z);
    vd.addViewable(new DVCore.SpriteViewable(pos, style, dbId));
    await vd.finish();
    return vd;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ANNOTATION UI
// ─────────────────────────────────────────────────────────────────────────────

function setupAnnotationUI(viewer) {
    const markupsExt = viewer.getExtension('Autodesk.Viewing.MarkupsCore');
    const dataVizExt = viewer.getExtension('Autodesk.DataVisualization');
    let activePinLabels = [];
    let isEditingMarkups = false;

    // ── Camera sync for HTML pin labels ──────────────────────────────────────
    viewer.addEventListener(Autodesk.Viewing.CAMERA_CHANGE_EVENT, () => {
        activePinLabels.forEach(lbl => {
            const sp = viewer.worldToClient(lbl.position);
            lbl.element.style.left = sp.x + 'px';
            lbl.element.style.top = sp.y + 'px';
        });
    });

    // ── Wipe annotations on model swap ───────────────────────────────────────
    viewer.addEventListener(Autodesk.Viewing.GEOMETRY_LOADED_EVENT, () => {
        try { markupsExt.leaveEditMode(); } catch (_) { }
        isEditingMarkups = false;
        updateMarkupStatus(false);
        markupsExt.clear();
        markupsExt.hide();
        dataVizExt.removeAllViewables();
        activePinLabels.forEach(l => l.element.remove());
        activePinLabels = [];
        exitImagePlacement();
    });

    const updateMarkupStatus = editing => {
        const badge = document.getElementById('markup-status-badge');
        if (!badge) return;
        badge.innerText = editing ? 'EDITING ACTIVE' : 'VIEWING ONLY';
        badge.style.background = editing ? '#10b981' : '#eee';
        badge.style.color = editing ? 'white' : '#888';
    };

    const enterMarkupMode = () => {
        markupsExt.show();
        if (!isEditingMarkups) { markupsExt.enterEditMode(); isEditingMarkups = true; }
        updateMarkupStatus(true);
    };

    // ── 2D: Draw Arrow ───────────────────────────────────────────────────────
    document.getElementById('btn-draw-arrow').onclick = () => {
        enterMarkupMode();
        markupsExt.changeEditMode(
            new Autodesk.Viewing.Extensions.Markups.Core.EditModeArrow(markupsExt)
        );
    };

    // ── 2D: Add Text ─────────────────────────────────────────────────────────
    document.getElementById('btn-add-text').onclick = () => {
        enterMarkupMode();
        markupsExt.changeEditMode(
            new Autodesk.Viewing.Extensions.Markups.Core.EditModeText(markupsExt)
        );
    };

    // ── 2D: Place Image — Phase 1 (PLACING) ──────────────────────────────────
    document.getElementById('btn-add-image-markup').onclick = async () => {
        let base64;
        try { base64 = await pickImageAsBase64(); }
        catch { return; }

        imgBase64 = base64;

        // Show the MarkupsCore overlay (so the SVG is ready for later injection)
        markupsExt.show();

        // Activate crosshair overlay
        placementLayer.classList.add('active');
    };

    // Phase 1 → Phase 2: user clicks on the placement overlay
    placementLayer.addEventListener('click', e => {
        if (!imgBase64) return;

        placementLayer.classList.remove('active');

        // Anchor point in viewer-container pixel space
        const cRect = viewer.container.getBoundingClientRect();
        const anchorX = e.clientX - cRect.left;
        const anchorY = e.clientY - cRect.top;

        enterEditingPhase(anchorX, anchorY);
    });

    // Escape cancels placement overlay
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') exitImagePlacement();
    });

    // ── Phase 2 → Phase 3: Confirm ───────────────────────────────────────────
    document.getElementById('img-btn-confirm').onclick = () => {
        if (!imgBase64) return;

        const svgEl = markupsExt.svg;
        if (!svgEl) { console.error('[ImageMarkup] SVG not ready'); return; }

        const svgRect = screenRectToSvgCoords(svgEl, imgState, viewer.container);
        if (!svgRect) { exitImagePlacement(); return; }

        commitImageToSvg(svgEl, svgRect, imgBase64);
        exitImagePlacement();
    };

    // ── Phase 2: Cancel ───────────────────────────────────────────────────────
    document.getElementById('img-btn-cancel').onclick = exitImagePlacement;

    // ── 2D: Save Markup (arrows + text + injected images) ────────────────────
    document.getElementById('btn-save-markup').onclick = async () => {
        const svgData = mergeInjectedImages(markupsExt);
        if (!svgData) return alert('Nothing to save — draw something or place an image first!');

        const payload = {
            urn: window.location.hash?.substring(1) || 'default_model',
            type: 'markup',
            svgData,
            cameraState: viewer.getState({ viewport: true }),
            text: '2D Annotation'
        };

        await fetch('/annotations', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        try { markupsExt.leaveEditMode(); } catch (_) { }
        isEditingMarkups = false;
        updateMarkupStatus(false);

        // Remove injected images from the live SVG (now committed to the DB)
        markupsExt.svg?.querySelectorAll('[data-markup-image]').forEach(el => el.remove());

        alert('2D Markup saved!');
    };

    // ── 3D: Text pin ─────────────────────────────────────────────────────────
    let droppingPin = false;
    document.getElementById('btn-drop-pin').onclick = () => {
        droppingPin = !droppingPin;
        droppingImagePin = false; pendingImageDataUrl = null;
        document.getElementById('btn-drop-pin').style.background = droppingPin ? '#ccc' : '';
        document.getElementById('btn-drop-image-pin').classList.remove('active');
        document.getElementById('btn-drop-image-pin').textContent = '🖼️ Drop Image Pin (3D)';
    };

    // ── 3D: Image pin ─────────────────────────────────────────────────────────
    let droppingImagePin = false;
    let pendingImageDataUrl = null;

    document.getElementById('btn-drop-image-pin').onclick = async () => {
        const btn = document.getElementById('btn-drop-image-pin');
        if (droppingImagePin) {
            droppingImagePin = false; pendingImageDataUrl = null;
            btn.classList.remove('active');
            btn.textContent = '🖼️ Drop Image Pin (3D)';
            return;
        }
        let base64;
        try { base64 = await pickImageAsBase64(); } catch { return; }
        pendingImageDataUrl = base64;
        droppingImagePin = true;
        droppingPin = false;
        document.getElementById('btn-drop-pin').style.background = '';
        btn.classList.add('active');
        btn.textContent = '🖼️ Click on model to place…';
    };

    // ── Unified click handler for 3D pins ─────────────────────────────────────
    viewer.container.addEventListener('click', async e => {
        if (!droppingPin && !droppingImagePin) return;

        const rect = viewer.container.getBoundingClientRect();
        const hit = viewer.clientToWorld(e.clientX - rect.left, e.clientY - rect.top);
        if (!hit?.point) return;

        const point = hit.point;
        const urn = window.location.hash?.substring(1) || 'default_model';

        // Text pin
        if (droppingPin) {
            const comment = prompt('Enter pin comment:');
            if (!comment) { droppingPin = false; document.getElementById('btn-drop-pin').style.background = ''; return; }
            await fetch('/annotations', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ urn, type: 'pin', position: point, text: comment })
            });
            droppingPin = false;
            document.getElementById('btn-drop-pin').style.background = '';
            alert('3D Pin saved!');
        }

        // Image pin
        if (droppingImagePin && pendingImageDataUrl) {
            const dbId = Date.now();
            try {
                const vd = await buildImageViewable(point, pendingImageDataUrl, dbId);
                dataVizExt.addViewables(vd);
            } catch (err) { console.error('[ImagePin]', err); }

            await fetch('/annotations', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ urn, type: 'image-pin', position: point, imageDataUrl: pendingImageDataUrl, dbId })
            });

            droppingImagePin = false; pendingImageDataUrl = null;
            const btn = document.getElementById('btn-drop-image-pin');
            btn.classList.remove('active');
            btn.textContent = '🖼️ Drop Image Pin (3D)';
            alert('3D Image Pin saved!');
        }
    });

    // ── Clear canvas ──────────────────────────────────────────────────────────
    document.getElementById('btn-clear-canvas').onclick = () => {
        try { markupsExt.leaveEditMode(); } catch (_) { }
        isEditingMarkups = false;
        updateMarkupStatus(false);
        try { markupsExt.unloadMarkupsAll(); } catch (_) { }
        markupsExt.clear();
        markupsExt.hide();
        markupsExt.svg?.querySelectorAll('[data-markup-image]').forEach(el => el.remove());
        dataVizExt.removeAllViewables();
        activePinLabels.forEach(l => l.element.remove());
        activePinLabels = [];
        exitImagePlacement();
    };

    // ── Reload & render all stored annotations ────────────────────────────────
    document.getElementById('btn-reload-render').onclick = async () => {
        const urn = window.location.hash?.substring(1) || 'default_model';
        const data = await (await fetch('/annotations?urn=' + encodeURIComponent(urn))).json();

        // Clear
        try { markupsExt.leaveEditMode(); } catch (_) { }
        isEditingMarkups = false;
        try { markupsExt.unloadMarkupsAll(); } catch (_) { }
        markupsExt.clear();
        markupsExt.svg?.querySelectorAll('[data-markup-image]').forEach(el => el.remove());
        dataVizExt.removeAllViewables();
        activePinLabels.forEach(l => l.element.remove());
        activePinLabels = [];

        const markupItems = [], imagePins = [];

        for (const item of data) {
            if (item.type === 'markup') {
                markupItems.push(item);

            } else if (item.type === 'pin') {
                const el = document.createElement('div');
                el.innerText = item.text;
                Object.assign(el.style, {
                    position: 'absolute', background: '#ffffff', padding: '5px 12px',
                    border: '2px solid #575757', borderRadius: '20px',
                    boxShadow: '0px 4px 6px rgba(0,0,0,0.3)', zIndex: '500',
                    pointerEvents: 'none', fontWeight: 'bold', color: '#333',
                    transform: 'translate(-50%,-50%)', whiteSpace: 'nowrap'
                });
                const sp = viewer.worldToClient(item.position);
                el.style.left = sp.x + 'px';
                el.style.top = sp.y + 'px';
                viewer.container.appendChild(el);
                activePinLabels.push({ position: item.position, element: el });

            } else if (item.type === 'image-pin') {
                imagePins.push(item);
            }
        }

        // Restore SVG markups (already contain embedded <image> nodes)
        if (markupItems.length > 0) {
            viewer.restoreState(markupItems[markupItems.length - 1].cameraState);
            markupsExt.show();
            markupItems.forEach((m, i) => markupsExt.loadMarkups(m.svgData, 'saved_layer_' + i));
        }

        // Restore 3D image pins
        for (const item of imagePins) {
            try {
                const vd = await buildImageViewable(item.position, item.imageDataUrl, item.dbId || Date.now());
                dataVizExt.addViewables(vd);
            } catch (err) { console.error('[Reload] image-pin:', err); }
        }

        alert(`Rendered ${data.length} stored annotation(s).`);
    };
}
