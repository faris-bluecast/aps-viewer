import { initViewer, loadModel } from './viewer.js';

initViewer(document.getElementById('preview')).then(async viewer => {
    const urn = window.location.hash?.substring(1);
    setupModelSelection(viewer, urn);
    setupModelUpload(viewer);

    await viewer.loadExtension('Autodesk.Viewing.MarkupsCore');
    await viewer.loadExtension('Autodesk.DataVisualization');
    setupAnnotationUI(viewer);
});

async function setupModelSelection(viewer, selectedUrn) {
    const dropdown = document.getElementById('models');
    dropdown.innerHTML = '';
    try {
        const resp = await fetch('/api/models');
        if (!resp.ok) {
            throw new Error(await resp.text());
        }
        const models = await resp.json();
        dropdown.innerHTML = models.map(model => `<option value=${model.urn} ${model.urn === selectedUrn ? 'selected' : ''}>${model.name}</option>`).join('\n');
        dropdown.onchange = () => onModelSelected(viewer, dropdown.value);
        if (dropdown.value) {
            onModelSelected(viewer, dropdown.value);
        }
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
        let data = new FormData();
        data.append('model-file', file);
        if (file.name.endsWith('.zip')) { // When uploading a zip file, ask for the main design file in the archive
            const entrypoint = window.prompt('Please enter the filename of the main design inside the archive.');
            data.append('model-zip-entrypoint', entrypoint);
        }
        upload.setAttribute('disabled', 'true');
        models.setAttribute('disabled', 'true');
        showNotification(`Uploading model <em>${file.name}</em>. Do not reload the page.`);
        try {
            const resp = await fetch('/api/models', { method: 'POST', body: data });
            if (!resp.ok) {
                throw new Error(await resp.text());
            }
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
        if (!resp.ok) {
            throw new Error(await resp.text());
        }
        const status = await resp.json();
        switch (status.status) {
            case 'n/a':
                showNotification(`Model has not been translated.`);
                break;
            case 'inprogress':
                showNotification(`Model is being translated (${status.progress})...`);
                window.onModelSelectedTimeout = setTimeout(onModelSelected, 5000, viewer, urn);
                break;
            case 'failed':
                showNotification(`Translation failed. <ul>${status.messages.map(msg => `<li>${JSON.stringify(msg)}</li>`).join('')}</ul>`);
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

function setupAnnotationUI(viewer) {
    let markupsExt = viewer.getExtension("Autodesk.Viewing.MarkupsCore");
    let dataVizExt = viewer.getExtension("Autodesk.DataVisualization");

    let activePinLabels = [];

    // Sync HTML Labels to 3D space during camera movement
    viewer.addEventListener(Autodesk.Viewing.CAMERA_CHANGE_EVENT, () => {
        activePinLabels.forEach(label => {
            const screenPoint = viewer.worldToClient(label.position);
            label.element.style.left = screenPoint.x + 'px';
            label.element.style.top = screenPoint.y + 'px';
        });
    });

    let isEditingMarkups = false;

    // Wipe out annotations when swapping to a new 3D model
    viewer.addEventListener(Autodesk.Viewing.GEOMETRY_LOADED_EVENT, () => {
        try { markupsExt.leaveEditMode(); } catch (e) { }
        isEditingMarkups = false;
        updateMarkupStatus(false);
        markupsExt.clear();
        markupsExt.hide();
        dataVizExt.removeAllViewables();
        activePinLabels.forEach(label => label.element.remove());
        activePinLabels = [];
    });

    const updateMarkupStatus = (isEditing) => {
        const badge = document.getElementById('markup-status-badge');
        if (!badge) return;
        if (isEditing) {
            badge.innerText = 'EDITING ACTIVE';
            badge.style.background = '#10b981';
            badge.style.color = 'white';
        } else {
            badge.innerText = 'VIEWING ONLY';
            badge.style.background = '#eee';
            badge.style.color = '#888';
        }
    };

    // Enable Markups
    const enterMarkupMode = () => {
        markupsExt.show();
        if (!isEditingMarkups) {
            markupsExt.enterEditMode();
            isEditingMarkups = true;
        }
        updateMarkupStatus(true);
    };

    document.getElementById('btn-draw-arrow').onclick = () => {
        enterMarkupMode();
        let arrow = new Autodesk.Viewing.Extensions.Markups.Core.EditModeArrow(markupsExt);
        markupsExt.changeEditMode(arrow);
    };

    document.getElementById('btn-add-text').onclick = () => {
        enterMarkupMode();
        let text = new Autodesk.Viewing.Extensions.Markups.Core.EditModeText(markupsExt);
        markupsExt.changeEditMode(text);
    };

    document.getElementById('btn-save-markup').onclick = async () => {
        const svgData = markupsExt.generateData();
        if (!svgData) return alert('No markup created or not in markup edit mode!');

        const cameraState = viewer.getState({ viewport: true });
        const urn = window.location.hash?.substring(1) || 'default_model';

        const payload = {
            urn: urn,
            type: 'markup',
            svgData: svgData,
            cameraState: cameraState,
            text: '2D Annotation'
        };

        await fetch('/annotations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        markupsExt.leaveEditMode();
        isEditingMarkups = false;
        updateMarkupStatus(false);
        alert('2D Markup saved!');
    };

    let droppingPin = false;
    document.getElementById('btn-drop-pin').onclick = () => {
        droppingPin = !droppingPin;
        document.getElementById('btn-drop-pin').style.background = droppingPin ? '#ccc' : '#fff';
    };

    viewer.container.addEventListener('click', async (e) => {
        if (!droppingPin) return;

        const rect = viewer.container.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const { point } = viewer.clientToWorld(x, y);
        if (point) {
            const comment = prompt("Enter pin comment:");
            if (!comment) {
                droppingPin = false;
                document.getElementById('btn-drop-pin').style.background = '#fff';
                return;
            }

            const urn = window.location.hash?.substring(1) || 'default_model';

            const payload = {
                urn: urn,
                type: 'pin',
                position: point,
                text: comment
            };

            await fetch('/annotations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            droppingPin = false;
            document.getElementById('btn-drop-pin').style.background = '#fff';
            alert('3D Pin saved!');
        }
    });

    document.getElementById('btn-clear-canvas').onclick = () => {
        try { markupsExt.leaveEditMode(); } catch (e) { }
        isEditingMarkups = false;
        updateMarkupStatus(false);
        try { markupsExt.unloadMarkupsAll(); } catch (e) { }
        markupsExt.clear();
        markupsExt.hide();
        dataVizExt.removeAllViewables();
        activePinLabels.forEach(label => label.element.remove());
        activePinLabels = [];
    };

    document.getElementById('btn-reload-render').onclick = async () => {
        const urn = window.location.hash?.substring(1) || 'default_model';
        const resp = await fetch('/annotations?urn=' + encodeURIComponent(urn));
        const data = await resp.json();

        try { markupsExt.leaveEditMode(); } catch (e) { }
        isEditingMarkups = false;
        try { markupsExt.unloadMarkupsAll(); } catch (e) { }
        markupsExt.clear();
        dataVizExt.removeAllViewables();
        activePinLabels.forEach(label => label.element.remove());
        activePinLabels = [];

        let markupsList = [];
        let viewableData = new Autodesk.DataVisualization.Core.ViewableData();
        viewableData.spriteSize = 32;

        let pinIndex = 1;

        for (let item of data) {
            if (item.type === 'markup') {
                markupsList.push(item);
            } else if (item.type === 'pin') {
                // Render the text as an HTML element directly in place of the icon
                const labelObj = document.createElement('div');
                labelObj.innerText = item.text;
                labelObj.style.position = 'absolute';
                labelObj.style.background = '#ffffff';
                labelObj.style.padding = '5px 12px';
                labelObj.style.border = '2px solid #575757';
                labelObj.style.borderRadius = '20px';
                labelObj.style.boxShadow = '0px 4px 6px rgba(0,0,0,0.3)';
                labelObj.style.zIndex = '500';
                labelObj.style.pointerEvents = 'none';
                labelObj.style.fontWeight = 'bold';
                labelObj.style.color = '#333';
                labelObj.style.transform = 'translate(-50%, -50%)'; // Center over point
                labelObj.style.whiteSpace = 'nowrap';

                const screenPoint = viewer.worldToClient(item.position);
                labelObj.style.left = screenPoint.x + 'px';
                labelObj.style.top = screenPoint.y + 'px';

                viewer.container.appendChild(labelObj);

                activePinLabels.push({
                    position: item.position,
                    element: labelObj
                });
            }
        }

        await viewableData.finish();
        dataVizExt.addViewables(viewableData);

        if (markupsList.length > 0) {
            const lastMarkup = markupsList[markupsList.length - 1];
            viewer.restoreState(lastMarkup.cameraState);

            markupsExt.show();
            for (let i = 0; i < markupsList.length; i++) {
                markupsExt.loadMarkups(markupsList[i].svgData, "saved_layer_" + i);
            }
        }

        alert(`Rendered ${data.length} stored comments from the database.`);
    };
}
