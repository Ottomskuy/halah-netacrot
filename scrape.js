(async () => {
    // 1. Cari URL components.json yang sudah dimuat oleh halaman
    const resources = performance.getEntriesByType("resource");
    const compRes = resources.find((r) => r.name.includes("components.json"));

    if (!compRes) {
        console.error("components.json tidak ditemukan di frame ini. Coba ganti dropdown 'top' di kiri atas Console ke iframe lain!");
        return;
    }

    const [rawUrl, queryString] = compRes.name.split("?");
    const baseUrl = rawUrl.replace(/components\.json$/, "");
    const suffix = queryString ? `?${queryString}` : "";

    console.log("Base URL terdeteksi:", baseUrl);

    const files = [
        "course.json",
        "contentObjects.json",
        "articles.json",
        "blocks.json",
        "components.json"
    ];

    // 2. Fetch kelima file JSON menggunakan sesi login browser aktif
    const rawData = {};
    for (const file of files) {
        try {
            const res = await fetch(baseUrl + file + suffix, { credentials: "include" });
            if (res.ok) {
                rawData[file.replace(".json", "")] = await res.json();
                console.log(`Berhasil unduh: ${file}`);
            }
        } catch (err) {
            console.warn(`Gagal unduh ${file}:`, err);
        }
    }

    // 3. Susun relasi hierarki: Module -> Page -> Article -> Block -> Component
    const stripHtml = (html) => {
        const div = document.createElement("div");
        div.innerHTML = html || "";
        return (div.textContent || div.innerText || "").replace(/\s+/g, " ").trim();
    };

    const coMap = new Map((rawData.contentObjects || []).map((x) => [x._id, x]));
    const artMap = new Map((rawData.articles || []).map((x) => [x._id, x]));
    const blkMap = new Map((rawData.blocks || []).map((x) => [x._id, x]));

    const structuredCourse = {
        title: stripHtml(rawData.course?.title || "NetAcad Course"),
        scrapedAt: new Date().toISOString(),
        modules: {},
        raw: rawData
    };

    (rawData.components || []).forEach((comp) => {
        const block = blkMap.get(comp._parentId);
        const article = block ? artMap.get(block._parentId) : null;
        const page = article ? coMap.get(article._parentId) : null;
        const parentModule = page ? coMap.get(page._parentId) : null;

        const moduleTitle = stripHtml(parentModule?.title || page?.title || "General");
        const pageTitle = stripHtml(page?.title || "Untitled Page");

        if (!structuredCourse.modules[moduleTitle]) {
            structuredCourse.modules[moduleTitle] = {};
        }
        if (!structuredCourse.modules[moduleTitle][pageTitle]) {
            structuredCourse.modules[moduleTitle][pageTitle] = [];
        }

        const itemEntry = {
            id: comp._id,
            type: comp._component,
            title: stripHtml(comp.title),
            body: stripHtml(comp.body)
        };

        // Jika komponen berupa kuis, ekstrak opsi & kunci jawabannya
        if (Array.isArray(comp._items)) {
            itemEntry.options = comp._items.map((opt) => ({
                text: stripHtml(opt.text),
                isCorrect: Boolean(opt._isCorrect || opt._shouldBeSelected)
            }));
        }

        structuredCourse.modules[moduleTitle][pageTitle].push(itemEntry);
    });

    // 4. Download hasil gabungan sebagai file JSON lokal
    const blob = new Blob([JSON.stringify(structuredCourse, null, 2)], {
        type: "application/json"
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const safeName = structuredCourse.title.replace(/[^a-z0-9]/gi, "_").toLowerCase();
    a.download = `${safeName || "netacad_course"}.json`;
    a.click();

    console.log("Selesai! Seluruh isi course berhasil di-export.");
})();