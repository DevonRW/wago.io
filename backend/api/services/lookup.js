/**
 * /lookup requests
 */
 
const lua = require('../helpers/lua')
const WCL = require('../helpers/WCL')
const battlenet = require('../helpers/battlenet')
const diff = require('../helpers/diff')
const wowPatches = require('../helpers/wowPatches')

module.exports = function (fastify, opts, next) {
  // returns data used on wago.io homepage 
  fastify.get('/index', (req, res) => {
    res.cache(60).send({top10: global.Top10Lists, news: global.LatestNews, addons: global.LatestAddons})
  })

  // standard lookup for any import
  fastify.get('/wago', async (req, res) => {
    if (!req.query.id) {
      return res.code(404).send({error: "page_not_found"})
    }
    var doc = await WagoItem.lookup(req.query.id)
    if (!doc || doc.deleted) {
      return res.code(404).send({error: "page_not_found"})
    }

    if (doc.private && (!req.user || !req.user._id.equals(doc._userId))) {
      return res.code(401).send({error: "page_not_accessible"})
    }
    
    doc.popularity.views++
    // quick hack to stop counting mdt embeds
    if (req.headers.referer && !req.headers.referer.match(/embed/)) {
      doc.popularity.viewsThisWeek++

      var ipAddress = req.raw.ip

      ViewsThisWeek.find({viewed: { $gt: new Date().getTime() - 1000 * 60 * 20 }, source: ipAddress, wagoID: doc._id}).then((recent) => {
        if (!recent || recent.length === 0) {
          doc.save()
          
          var pop = new ViewsThisWeek()
          pop.wagoID = doc._id
          pop.source = ipAddress
          pop.save()
        }
      })
    }
  
    var wago = {}
    wago._id = doc._id
    if (doc.type === 'WEAKAURAS2') {
      wago.type = 'WEAKAURA'
    }
    else {
      wago.type = doc.type
    }
    if (doc.description_format === '1' || !doc.description_format) {
      doc.description_format = 'bbcode'
    }
    else if (doc.description_format === '2') {
      doc.description_format = 'markdown'
    }

    req.tracking.name = doc.name

    wago.name = doc.name
    wago.slug = doc.slug
    wago.url = doc.url
    wago.visibility = { private: doc.private, hidden: doc.hidden, deleted: doc.deleted }
    wago.date = { created: doc.created, modified: doc.modified }
    wago.expires = doc.expires_at
    wago.patch = wowPatches.patchByDate(doc.modified || doc.created)
    wago.description = { text: doc.description, format: doc.description_format }
    wago.categories = doc.categories
    
    wago.viewCount = doc.popularity.views
    wago.viewsThisWeek = doc.popularity.viewsThisWeek
    wago.commentCount = doc.popularity.comment_count
    wago.downloadCount = doc.popularity.downloads
    wago.embedCount = doc.popularity.embeds
    wago.favoriteCount = doc.popularity.favorite_count
    wago.installCount = doc.popularity.installed_count
    wago.UID = doc._userId
    wago.alerts = {}

    const getUser = async () => {
      if (!wago.UID) {
        wago.user = {          
          name: null,
          searchable: false,
          roleClass: 'user-anon',
          avatar: '/media/avatars/anon.png'
        }
        return
      }

      const user = await User.findById(wago.UID).exec()
      if (!user) {
        // should always find a match but if something is whack...
        wago.user = {          
          name: null,
          searchable: false,
          roleClass: 'user-anon',
          avatar: '/media/avatars/anon.png'
        }
        return
      }
      wago.user = {
        name: user.account.username,
        searchable: !user.account.hidden,
        roleClass: user.roleclass,
        avatar: user.avatarURL,
        enableLinks: user.account.verified_human
      }
      return
    }
    const isMyStar = async () => {
      if (req.user) {
        const star = await WagoFavorites.findOne({wagoID: wago._id, userID: req.user._id, type: 'Star'}).exec()
        if (star) {
          wago.myfave = true
        }
        return
      }
      else {
        return
      }
    }
    const getScreenshots = async () => {
      const screens = await Screenshot.findForWago(wago._id)
      if (!screens) {
        return
      }
      wago.screens = []
      screens.forEach((screen) => {
        wago.screens.push({_id: screen._id.toString(), src: screen.url, title: screen.caption})
      })
      return
    }
    const getVideos = async () => {
      const videos = await Video.findForWago(wago._id)
      if (!videos) {
        return
      }
      wago.videos = []
      videos.forEach((video) => {
        wago.videos.push({_id: video._id.toString(), url: video.url, thumb: video.thumbnail, embed: video.embed})
      })
      return
    }
    const getMedia = async () => {
      if (doc.type === 'IMAGE') {
        wago.image = doc.image[0]
        for (file in wago.image.files) {
          if (!wago.image.files.hasOwnProperty(file)) {
            continue
          }
          if (wago.image.files[file].indexOf(/https?:\/\//) < 0) {
            wago.image.files[file] = 'https://media.wago.io/images/'  + wago.image.files[file]
          }
        }
      }
      return
    }
    const getCollections = async () => {
      if (doc.type === 'COLLECTION') {
        return
      }
      var search
      var count
      wago.collectionCount = 0
      wago.collections = []
      wago.myCollections = []
      if (req.user) {
        search = WagoItem.find({type: 'COLLECTION', collect: doc._id, deleted: false, "$or": [{ '_userId': req.user._id || null }, { private: false, hidden: false }]})
        count = WagoItem.countDocuments({type: 'COLLECTION', collect: doc._id, deleted: false, "$or": [{ '_userId': req.user._id || null }, { private: false, hidden: false }]})
      }
      else {
        search = WagoItem.find({type: 'COLLECTION',collect: doc._id, deleted: false, private: false, hidden: false})
        count = WagoItem.countDocuments({type: 'COLLECTION', collect: doc._id, deleted: false, private: false, hidden: false})
      }

      wago.collectionCount = await count.exec()
      if (!wago.collectionCount) {
        return
      }
      var collections = await search.sort('-modified').limit(10).populate('_userId').exec()
      collections.forEach((c) => {
        wago.collections.push({name: c.name, _id: c._id, slug: c.slug, modified: c.modified, user: {name: c._userId.profile.name, class: c._userId.roleclass, avatar: c._userId.avatarURL, profile: c._userId.profile.url}})
        if (req.user && req.user._id.equals(c._userId._id)) {
          wago.myCollections.push(c._id.toString())
        }
      })
      return
    }
    const getVersionHistory = async () => {
      if (doc.type === 'COLLECTION') {
        return
      }
      var versions = await WagoCode.find({auraID: wago._id}).sort({updated: -1}).exec()
      if (!versions) {
        return
      }
      var versionHistory = []
      versions.forEach((v) => {
        var versionString = v.versionString
        if (versionString !== '1.0.' + (v.version - 1) && versionString !== '0.0.' + v.version) {
          versionString = versionString + '-' + v.version
        }
        versionHistory.push({version: v.version, versionString: versionString, size: (v.json && v.json.length || v.lua && v.lua.length || v.encoded && v.encoded.length || 0), date: v.updated, changelog: v.changelog})
      })
      wago.versions = {total: versions.length, versions: versionHistory}

      // include code URL for selected version
      if (req.query.version) {
        wago.codeURL = `/lookup/wago/code?id=${doc._id}&version=${req.query.version}`
      }
      else {
        wago.codeURL = `/lookup/wago/code?id=${doc._id}&version=${wago.versions.versions[0].versionString}`
      }
      return
    }
    const getComments = async () => {
      var count = await Comments.countDocuments({wagoID: wago._id}).exec()
      wago.commentCount = count
      wago.comments = []
      var comments = await Comments.find({wagoID: wago._id}).sort({postDate: -1}).limit(10).populate('authorID').exec()
      if (!comments) {
        return
      }
      comments.forEach((c) => {
        wago.comments.push({
          cid: c._id.toString(),
          date: c.postDate,
          text: c.commentText,
          format: 'bbcode',
          canMod: (req.user && ((req.user.isAdmin && (req.user.isAdmin.moderator || req.user.isAdmin.super)) || req.user._id.equals(c.authorID._id) || req.user._id.equals(wago.UID))),
          author: {
            name: c.authorID.account.username || 'User-' + c.authorID._id.toString(),
            avatar: c.authorID.avatarURL,
            class: c.authorID.roleclass,
            profile: c.authorID.profile.url,
            enableLinks: c.authorID.account.verified_human
          }
        })
      })
      return
    }
    const getFork = async () => {
      if (!doc.fork_of || wago.type === 'COLLECTION') {
        return
      }
      var fork = await WagoItem.findById(doc.fork_of).exec()
      if (!fork || fork.hidden || fork.private) {
        return
      }
      wago.fork = {_id: fork._id.toString(), name: fork.name}
      return
    }
    // run tasks in parallel
    await Promise.all([getUser(), isMyStar(), getScreenshots(), getVideos(), getMedia(), getCollections(), getVersionHistory(), getComments(), getFork()])
    return res.send(wago)
  })

  // return array of git-formatted diffs comparing two versions of code
  fastify.get('/wago/diffs', async (req, res) => {
    if (!req.query.id || !req.query.left || !req.query.right) {
      return res.code(404).send({error: "page_not_found"})
    }
    const doc = await WagoItem.lookup(req.query.id)
    if (!doc || doc.deleted) {
      return res.code(404).send({error: "page_not_found"})
    }

    if (doc.private && (!req.user || !req.user._id.equals(doc._userId))) {
      return res.code(404).send({error: "page_not_found"})
    }
    const left = WagoCode.lookup(doc._id, req.query.left)
    const right = WagoCode.lookup(doc._id, req.query.right)
    var tables = {left: await left, right: await right}
    try {
      tables.left = tables.left.json || tables.left.lua
      tables.right = tables.right.json || tables.right.lua
    }
    catch (e) {
      return res.send([])
    }    
    
    if (doc.type === 'SNIPPET') {
      return res.cache(604800).send(await diff.Lua(tables.left, tables.right))
    }
    if (doc.type === 'PLATER') {
      return res.cache(604800).send(await diff.Plater(tables.left, tables.right))
    }
    else if (doc.type === 'WEAKAURAS2') {
      return res.cache(604800).send(await diff.WeakAuras(tables.left, tables.right))
    }
    else {
      return res.cache(604800).send([])
    }
  })

  // returns a cache-able object of a wago's code
  fastify.get('/wago/code', async (req, res) => {
    if (!req.query.id) {
      return res.code(404).send({error: "page_not_found"})
    }
    var doc = await WagoItem.lookup(req.query.id)
    if (!doc || doc.deleted) {
      return res.code(404).send({error: "page_not_found"})
    }

    if (doc.private && (!req.user || !req.user._id.equals(doc._userId))) {
      return res.code(401).send({error: "page_not_accessible"})
    }

    var code = await WagoCode.lookup(doc._id, req.query.version)
    if (!code) {
      return res.code(403).send({error: "code not available"})
    }

    if (req.query.version && code.versionString !== req.query.version.replace(/-\d+$/, '')) {
      if (!req.query.version) {
        // save latest version data to wagoitem (for older imports)
        doc.latestVersion = {
          versionString: code.versionString,
          iteration: code.version,
          changelog: {
            text: code.changelog.text || '',
            format: code.changelog.text || 'bbcode',
          }
        }
        doc.save()
      }
      return res.code(302).redirect(`/lookup/wago/code?id=${req.query.id}&version=${code.versionString}`)
    }
          
    var versionString = code.versionString
    if (versionString !== '1.0.' + (code.version - 1) && versionString !== '0.0.' + code.version) {
      // append build # if version numbers are not sequential
      versionString = versionString + '-' + code.version
    }

    var wagoCode = {alerts: {}}

    // check for alerts
    // functions blocked by WeakAuras
    if (code.json) {
      while ((m = commonRegex.WeakAuraBlacklist.exec(code.json)) !== null) {
        if (!wagoCode.alerts.blacklist) {
          wagoCode.alerts.blacklist = []
        }
        wagoCode.alerts.blacklist.push(m[1].replace(/\\"/g, '"'))
      }
      
      // check for functions that could be used for malintent
      while ((m = commonRegex.MaliciousCode.exec(code.json)) !== null) {
        if (!wagoCode.alerts.malicious) {
          wagoCode.alerts.malicious = []
        }
        wagoCode.alerts.malicious.push(m[1])
      }
    }

    if (doc.type === 'SNIPPET') {
      wagoCode.lua = code.lua
      wagoCode.version = code.version
      wagoCode.versionString = versionString
      wagoCode.changelog = code.changelog
    }
    else if (doc.type === 'WEAKAURA') {
      var json = JSON.parse(code.json)
      // check if json needs version information added
      if (code.version && ((json.d.version !== code.version || json.d.url !== wago.url + '/' + code.version) || (json.c && json.c[0].version !== code.version) || (json.d.semver !== code.versionString))) {
        json.d.url = wago.url + '/' + code.version
        json.d.version = code.version
        json.d.semver = code.versionString

        if (json.c) {
          for (let i = 0; i < json.c.length; i++) {
            json.c[i].url = wago.url + '/' + code.version
            json.c[i].version = code.version
            json.c[i].semver = code.versionString
          }
        }

        code.json = JSON.stringify(json)
        var encoded = await lua.JSON2WeakAura(code.json)
        if (encoded) {
          code.encoded = encoded
        }
        code.save()
      }
      wagoCode.json = code.json
      wagoCode.encoded = code.encoded
      wagoCode.version = code.version
      wagoCode.versionString = versionString
      wagoCode.changelog = code.changelog
    }
    else {
      wagoCode.json = code.json
      wagoCode.encoded = code.encoded
      wagoCode.version = code.version
      wagoCode.versionString = versionString
      wagoCode.changelog = code.changelog
    }
    res.cache(604800).send(wagoCode)
  })

  // return array of collections this import is included in
  fastify.get('/wago/collections', async (req, res) => {
    if (!req.query.id) {
      return res.code(404).send({error: "page_not_found"})
    }
    const docs = await WagoItem.find({"type": "COLLECTION", "collect": req.query.id, "deleted": false, "private": false, "hidden": false}).sort('-modified').skip(10).populate('_userId').exec()
    if (!docs) {
      return res.send([])
    }
    var collections = []
    docs.forEach((c) => {
      collections.push({name: c.name, slug: c.slug, modified: c.modified, user: {name: c._userId.profile.name, class: c._userId.roleclass, avatar: c._userId.avatarURL, profile: c._userId.profile.url}})
    })
    return res.send(collections)
  })

  // find "more" comments on this import
  fastify.get('/wago/comments', async (req, res, next) => {
    if (!req.query.id || !req.query.page) {
      return res.code(404).send({error: "page_not_found"})
    }
    const docs = await Comments.find({wagoID: req.query.id}).sort({postDate: -1}).limit(10).skip(10 * parseInt(req.query.page)).populate('authorID').exec()
    if (!docs) {
      return res.send([])
    }
    var comments = []
    docs.forEach((c) => {
      comments.push({
        cid: c._id.toString(),
        date: c.postDate, 
        text: c.commentText, 
        format: 'bbcode',
        author: { 
          name: c.authorID.account.username || 'User-' + c.authorID._id.toString(),
          avatar: c.authorID.avatarURL,
          class: c.authorID.roleclass,
          profile: c.authorID.profile.url,
          enableLinks: c.authorID.account.verified_human
        }
      })
    })
    return res.send(comments)
  })

  // get profile info for user search
  fastify.get('/profile', async (req, res, next) => {
    if (!req.query.user) {
      return res.code(404).send({error: "page_not_found"})
    }

    const user = await User.findByUsername(req.query.user)
    if (!user) {
      return res.send({})
    }
    var profile = {}
    profile.public = !(user.account.hidden)
    profile.name = user.account.username
    profile.roleClass = user.roleClass
    profile.description = user.profile.description
    profile.avatar = user.avatarURL
    if (req.user && req.user._id.equals(user._id)) {
      profile.mine = true
    }
    res.send(profile)
  })

  // get a single blog post
  fastify.get('/blog', async (req, res) => {
    if (!req.query.id) {
      return res.code(404).send({error: "page_not_found"})
    }

    const doc = await Blog.findOne({_id: req.query.id, publishStatus: 'publish'}).populate('_userId').exec()    
    if (doc) {
      res.cache(300).send({
        content: doc.content,
        date: doc.date,
        format: doc.format,
        title: doc.title,
        _id: doc._id,
        publishStatus: doc.publishStatus,
        user: {
          username: doc._userId.account.username,
          css: doc._userId.roleclass
        }
      })
    }
    else {
      return res.code(404).send({error: "page_not_found"})
    }
  })

  // get a page of up to 3 blog posts
  fastify.get('/blogs', async (req, res) => {
    if (!req.query.page) {
      return res.code(404).send({error: "page_not_found"})
    }
    
    var pageNum = parseInt(req.query.page)
    if (pageNum <= 0) {
      return res.code(404).send({error: "page_not_found"})
    }
    // reduce to zero-index
    pageNum--
    
    var data = {news: []}
    const blogPage = Blog.find({publishStatus: 'publish'}).populate('_userId').sort('-date').limit(3).skip(pageNum * 3).exec()
    const blogOldest = Blog.findOne({publishStatus: 'publish'}).sort('date').select('_id').exec()
    const blogNewest = Blog.findOne({publishStatus: 'publish'}).sort('-date').select('_id').exec()
    const blogs = await blogPage
    blogs.forEach((doc) => {
      data.news.push({
        content: doc.content,
        date: doc.date,
        format: doc.format,
        title: doc.title,
        _id: doc._id,
        publishStatus: doc.publishStatus,
        user: {
          username: doc._userId.account.username,
          css: doc._userId.roleclass
        }
      })
    })
    data.oldest = await blogOldest
    data.newest = await blogNewest
    res.cache(300).send(data)
  })

  // look up WCL data
  fastify.get('/wcl/dungeons', async (req, res) => {
    if (req.query.log) {
      const dungeons = await WCL.getDungeons(req.query.log)
      res.cache(180).send(dungeons)
    }
  })
  fastify.get('/wcl/mdt-events', async (req, res) => {
    if (req.query.log) {
      const dungeon = await WCL.generateMDT(req.query.log, parseInt(req.query.dungeon) || 0)
      res.cache(180).send(dungeon)
    }
  })

  // get site stats
  fastify.get('/statistics', async (req, res) => {
    if (!req.user || !req.user.access.beta) {
      return res.code(403).send({error: 'no_access'})
    }
    const docs = await Stats.find().sort({name: 1, date: 1}).exec()
    var stats = []
    docs.forEach((item) => {
      if (!stats.length || stats[stats.length - 1].name !== item.name) {
        stats.push({name: item.name, data: [item.value]})
      }
      else {
        stats[stats.length - 1].data.push(item.value)
      }   
    })
    res.cache(3600).send(stats) 
  })


  // Blizzard web API proxy 
  fastify.get('/blizzard/spell', async (req, res) => {
    if (parseInt(req.query.id)) {
      const spell = await battlenet.lookupSpell(req.query.id)
      res.cache(604800).send(spell)
    }
    else if (req.query.text) {
      const spell = await battlenet.searchSpell(req.query.text)
      res.cache(604800).send(spell)
    }
    else {
      res.send({})
    }
  })

  next()  
}